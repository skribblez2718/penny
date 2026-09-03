import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { canonicalJson, sha256 } from "../src/checkpointer.js";
import { CompositionAdmissionError, validateSemanticComposition } from "../src/composition.js";
import type { ArtifactRef, SkillContract } from "../src/contracts.js";
import { DECIDE_SKILL_CONTRACT } from "../src/playbooks/decide.js";
import { RESEARCH_SKILL_CONTRACT } from "../src/playbooks/research.js";
import { sealAssessmentDraft, type AssessmentDraftV1 } from "../src/skill-contracts/assess.js";
import {
  decisionRequestSha256,
  decisionSourceLineageSha256,
  sealDecisionDraft,
} from "../src/skill-contracts/decide.js";
import { validateGroundedSynthesis } from "../src/skill-contracts/research.js";
import { decisionDraft, decisionRequest } from "./fixtures/decision-fixtures.js";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(path.join(tmpdir(), "penny-composition-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function groundedSynthesis(): unknown {
  const fixture: unknown = JSON.parse(
    readFileSync(
      new URL("./fixtures/skills/research/positive-vectors.json", import.meta.url),
      "utf8"
    )
  );
  if (fixture === null || typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new Error("positive composition fixture is malformed");
  }
  if (!("grounded_synthesis" in fixture)) throw new Error("grounded synthesis fixture is absent");
  return validateGroundedSynthesis(fixture.grounded_synthesis);
}

function persistCore(
  store: ArtifactStore,
  content = canonicalJson(groundedSynthesis()),
  operationId = "grounded-synthesis-core"
): ArtifactRef {
  return store.persist({
    metadata: {
      schema_version: 2,
      run_id: "prior-research-run",
      phase: "sealing_core",
      branch_id: null,
      kind: "semantic-core",
      operation_id: operationId,
      version: 1,
      producer: "host:research-core",
      media_type: "application/json",
      content_schema: { schema_id: "penny.grounded-synthesis.v1", schema_version: 1 },
      parent_ref: null,
      upstream_refs: [],
    },
    content,
  });
}

function input(ref: ArtifactRef, slot = "previous-skill-terminal-output") {
  return { schema_version: 2 as const, artifacts: [{ slot, ref }] };
}

function requiredContract(): SkillContract {
  const contract = structuredClone(RESEARCH_SKILL_CONTRACT);
  contract.io.input_ports = contract.io.input_ports.map((port) =>
    port.name === "prior_grounded_synthesis" ? { ...port, min_items: 1 } : port
  );
  return contract;
}

function decisionConsumerContract(): SkillContract {
  const contract = structuredClone(RESEARCH_SKILL_CONTRACT);
  contract.io.input_ports = [
    {
      schema_version: 1,
      name: "prior_decision",
      direction: "input",
      transport: "artifact",
      schema_id: "penny.decision.v2",
      schema_version_required: 2,
      artifact_kind: "semantic-core",
      source: "prior_skill",
      min_items: 1,
      max_items: 1,
      semantic_product: true,
    },
  ];
  return contract;
}

function assessmentConsumerContract(): SkillContract {
  const contract = structuredClone(RESEARCH_SKILL_CONTRACT);
  contract.io.input_ports = [
    {
      schema_version: 1,
      name: "prior_assessment",
      direction: "input",
      transport: "artifact",
      schema_id: "penny.assessment.v1",
      schema_version_required: 1,
      artifact_kind: "semantic-core",
      source: "prior_skill",
      min_items: 1,
      max_items: 1,
      semantic_product: true,
    },
  ];
  return contract;
}

function persistAssessment(store: ArtifactStore): ArtifactRef {
  const request = {
    schema_version: 1 as const,
    assessment_purpose: "Assess a supplied greeting.",
    target: "Hello.",
    criteria: [{ statement: "The target is a greeting.", importance: "required" as const }],
    supplied_evidence: [{ statement: "The text says Hello." }],
    hard_constraints: [],
    non_goals: [],
    known_uncertainties: [],
  };
  const draft: AssessmentDraftV1 = {
    schema_version: 1,
    disposition: "meets",
    criterion_outcomes: [
      {
        criterion_index: 0,
        verdict: "met",
        supporting_evidence_indexes: [0],
        contradicting_evidence_indexes: [],
        rationale: "The target and supplied evidence identify a greeting.",
      },
    ],
    summary: "The target meets the greeting criterion.",
    strengths: [
      {
        statement: "The target is a direct greeting.",
        criterion_indexes: [0],
        evidence_indexes: [0],
      },
    ],
    gaps: [],
    improvement_suggestions: [],
    assumptions: [],
    uncertainties: [],
    request_coverage: {
      assessment_purpose_covered: true,
      target_statement_indexes: [0],
      criterion_indexes: [0],
      supplied_evidence_indexes: [0],
      hard_constraint_indexes: [],
      non_goal_indexes: [],
      known_uncertainty_indexes: [],
    },
    confidence: "PROBABLE",
    external_actions_performed: false,
    filesystem_writes_performed: false,
    tests_executed: false,
    changes_started: false,
  };
  const requestRef = store.persist({
    metadata: {
      schema_version: 2,
      run_id: "prior-assess-run",
      phase: "intake",
      branch_id: null,
      kind: "assessment-request",
      operation_id: "assessment-request:fixture",
      version: 1,
      producer: "host:request-admission",
      media_type: "application/json",
      content_schema: { schema_id: "penny.assessment-request.v1", schema_version: 1 },
      parent_ref: null,
      upstream_refs: [],
    },
    content: canonicalJson(request),
  });
  const analysisRef = store.persist({
    metadata: {
      schema_version: 2,
      run_id: "prior-assess-run",
      phase: "analyzing_assessment",
      branch_id: null,
      kind: "agent-output",
      operation_id: "assessment-analysis:fixture",
      version: 1,
      producer: "agent:annie",
      media_type: "text/plain; charset=utf-8",
      parent_ref: null,
      upstream_refs: [requestRef],
    },
    content: "analysis",
  });
  const draftRef = store.persist({
    metadata: {
      schema_version: 2,
      run_id: "prior-assess-run",
      phase: "authoring_assessment",
      branch_id: null,
      kind: "assessment-draft",
      operation_id: "assessment-draft:fixture",
      version: 1,
      producer: "agent:carren",
      media_type: "text/plain; charset=utf-8",
      content_schema: { schema_id: "penny.assessment-draft.v1", schema_version: 1 },
      parent_ref: null,
      upstream_refs: [requestRef, analysisRef],
    },
    content: canonicalJson(draft),
  });
  const assessment = sealAssessmentDraft({ request, draft, requestRef, analysisRef, draftRef });
  return store.persist({
    metadata: {
      schema_version: 2,
      run_id: "prior-assess-run",
      phase: "sealing_assessment",
      branch_id: null,
      kind: "semantic-core",
      operation_id: "sealed-assessment",
      version: 1,
      producer: "host:assessment-sealer",
      media_type: "application/json",
      content_schema: { schema_id: "penny.assessment.v1", schema_version: 1 },
      parent_ref: null,
      upstream_refs: [requestRef, analysisRef, draftRef],
    },
    content: canonicalJson(assessment),
  });
}

function persistDecision(store: ArtifactStore, operationId = "sealed-decision"): ArtifactRef {
  const request = decisionRequest();
  const decision = sealDecisionDraft({
    request,
    draft: decisionDraft("selected"),
    requestSha256: decisionRequestSha256(request),
    sourceRequestArtifactId: `art_${"c".repeat(64)}`,
    sourceDraftArtifactId: `art_${"d".repeat(64)}`,
    exactInputArtifactIds: [],
  });
  return store.persist({
    metadata: {
      schema_version: 2,
      run_id: "prior-decide-run",
      phase: "sealing_decision",
      branch_id: null,
      kind: "semantic-core",
      operation_id: operationId,
      version: 1,
      producer: "host:decision-sealer",
      media_type: "application/json",
      content_schema: { schema_id: "penny.decision.v2", schema_version: 2 },
      parent_ref: null,
      upstream_refs: [],
    },
    content: canonicalJson(decision),
  });
}

describe("generic exact-byte semantic composition", () => {
  it("admits one exact canonical GroundedSynthesisV1 through Research and optional Decide ports", () => {
    using store = new ArtifactStore(path.join(root(), "artifacts"));
    const ref = persistCore(store);
    expect(() =>
      validateSemanticComposition({
        contract: requiredContract(),
        inputArtifacts: input(ref),
        artifactReader: store,
      })
    ).not.toThrow();
    expect(() =>
      validateSemanticComposition({
        contract: DECIDE_SKILL_CONTRACT,
        inputArtifacts: input(ref),
        artifactReader: store,
      })
    ).not.toThrow();
  });

  it("refuses stale refs, corrupt canonical bytes, wrong kind/version, and envelope substitution", () => {
    using store = new ArtifactStore(path.join(root(), "artifacts"));
    const canonical = persistCore(store);
    const corrupt = persistCore(
      store,
      `${JSON.stringify(groundedSynthesis(), null, 2)}\n`,
      "corrupt-grounded-synthesis-core"
    );
    const vectors: ArtifactRef[] = [
      { ...canonical, content_digest: "f".repeat(64) },
      corrupt,
      { ...canonical, kind: "research-product-envelope" },
      {
        ...canonical,
        content_schema: {
          schema_id: "penny.grounded-synthesis.v1",
          schema_version: 2,
        },
      },
      {
        ...canonical,
        kind: "research-product-envelope",
        content_schema: {
          schema_id: "penny.research-product-envelope.v1",
          schema_version: 1,
        },
      },
    ];
    for (const ref of vectors) {
      expect(() =>
        validateSemanticComposition({
          contract: requiredContract(),
          inputArtifacts: input(ref),
          artifactReader: store,
        })
      ).toThrow(CompositionAdmissionError);
    }
  });

  it("admits canonical AssessmentV1 and rejects noncanonical assessment bytes", () => {
    using store = new ArtifactStore(path.join(root(), "artifacts"));
    const ref = persistAssessment(store);
    expect(() =>
      validateSemanticComposition({
        contract: assessmentConsumerContract(),
        inputArtifacts: input(ref),
        artifactReader: store,
      })
    ).not.toThrow();
    const value: unknown = JSON.parse(store.readById(ref.artifact_id).toString("utf8"));
    const corrupt = store.persist({
      metadata: { ...store.metadata(ref), operation_id: "corrupt-assessment" },
      content: `${JSON.stringify(value, null, 2)}\n`,
    });
    expect(() =>
      validateSemanticComposition({
        contract: assessmentConsumerContract(),
        inputArtifacts: input(corrupt),
        artifactReader: store,
      })
    ).toThrow(/COMPOSITION_SEMANTIC_INVALID/u);
  });

  it("admits canonical DecisionV2 and rejects corrupt or selected-infeasible canonical products", () => {
    using store = new ArtifactStore(path.join(root(), "artifacts"));
    const ref = persistDecision(store);
    expect(() =>
      validateSemanticComposition({
        contract: decisionConsumerContract(),
        inputArtifacts: input(ref),
        artifactReader: store,
      })
    ).not.toThrow();
    const decision: unknown = JSON.parse(store.readById(ref.artifact_id).toString("utf8"));
    const corrupt = store.persist({
      metadata: {
        ...store.metadata(ref),
        operation_id: "corrupt-decision",
      },
      content: `${JSON.stringify(decision, null, 2)}\n`,
    });
    expect(() =>
      validateSemanticComposition({
        contract: decisionConsumerContract(),
        inputArtifacts: input(corrupt),
        artifactReader: store,
      })
    ).toThrow(/COMPOSITION_SEMANTIC_INVALID/u);

    const request = decisionRequest();
    const selected = decisionDraft("selected");
    const invalidDraft = {
      ...selected,
      feasibility: selected.feasibility.map((entry) =>
        entry.alternative_id === "alt_a" ? { ...entry, status: "infeasible" as const } : entry
      ),
    };
    const validProduct = sealDecisionDraft({
      request,
      draft: selected,
      requestSha256: decisionRequestSha256(request),
      sourceRequestArtifactId: `art_${"c".repeat(64)}`,
      sourceDraftArtifactId: `art_${"d".repeat(64)}`,
      exactInputArtifactIds: [],
    });
    const lineagePreimage = {
      request_artifact_id: validProduct.source_lineage.request_artifact_id,
      draft_artifact_id: validProduct.source_lineage.draft_artifact_id,
      draft_sha256: sha256(canonicalJson(invalidDraft)),
      input_artifact_ids: validProduct.source_lineage.input_artifact_ids,
    };
    const semanticInvalid = store.persist({
      metadata: {
        ...store.metadata(ref),
        operation_id: "selected-infeasible-decision",
      },
      content: canonicalJson({
        ...validProduct,
        ...invalidDraft,
        source_lineage: {
          ...lineagePreimage,
          lineage_sha256: decisionSourceLineageSha256(lineagePreimage),
        },
      }),
    });
    expect(() =>
      validateSemanticComposition({
        contract: decisionConsumerContract(),
        inputArtifacts: input(semanticInvalid),
        artifactReader: store,
      })
    ).toThrow(/selected DecisionDraftV2 must recommend exactly one feasible alternative/u);
  });

  it("refuses missing required ports, ambiguous ports, and absent validators", () => {
    using store = new ArtifactStore(path.join(root(), "artifacts"));
    const ref = persistCore(store);
    expect(() =>
      validateSemanticComposition({ contract: requiredContract(), artifactReader: store })
    ).toThrow(/COMPOSITION_PORT_CARDINALITY/u);

    const ambiguous = requiredContract();
    const port = ambiguous.io.input_ports.find(
      (candidate) => candidate.name === "prior_grounded_synthesis"
    );
    if (port === undefined) throw new Error("fixture semantic port is absent");
    ambiguous.io.input_ports.push({ ...port, name: "also_grounded_synthesis" });
    expect(() =>
      validateSemanticComposition({
        contract: ambiguous,
        inputArtifacts: input(ref),
        artifactReader: store,
      })
    ).toThrow(/COMPOSITION_PORT_AMBIGUOUS/u);

    expect(() =>
      validateSemanticComposition({
        contract: requiredContract(),
        inputArtifacts: input(ref),
        artifactReader: store,
        validators: new Map(),
      })
    ).toThrow(/COMPOSITION_VALIDATOR_MISSING/u);
  });
});
