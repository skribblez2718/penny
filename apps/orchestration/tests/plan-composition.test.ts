import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactStore,
  PLAN_SKILL_CONTRACT,
  canonicalJson,
  decisionRequestSha256,
  sealDecisionDraft,
  type ArtifactRef,
} from "../src/index.js";
import { CompositionAdmissionError, validateSemanticComposition } from "../src/composition.js";
import { validateGroundedSynthesis } from "../src/skill-contracts/research.js";
import { decisionDraft, decisionRequest } from "./fixtures/decision-fixtures.js";

const roots: string[] = [];
let operationSequence = 0;

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-plan-composition-"));
  roots.push(root);
  return root;
}

function groundedSynthesis(): unknown {
  const fixture: unknown = JSON.parse(
    readFileSync(
      new URL("./fixtures/skills/research/positive-vectors.json", import.meta.url),
      "utf8"
    )
  );
  if (fixture === null || typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new Error("grounded synthesis fixture is malformed");
  }
  if (!("grounded_synthesis" in fixture)) throw new Error("grounded synthesis fixture is absent");
  return validateGroundedSynthesis(fixture.grounded_synthesis);
}

function persistGrounded(
  store: ArtifactStore,
  content: unknown = groundedSynthesis()
): ArtifactRef {
  operationSequence += 1;
  return store.persist({
    metadata: {
      schema_version: 2,
      run_id: "prior-research",
      phase: "sealing_core",
      branch_id: null,
      kind: "semantic-core",
      operation_id: `prior-grounded-synthesis-${operationSequence}`,
      version: 1,
      producer: "host:research-core",
      media_type: "application/json",
      content_schema: { schema_id: "penny.grounded-synthesis.v1", schema_version: 1 },
      parent_ref: null,
      upstream_refs: [],
    },
    content: canonicalJson(content),
  });
}

function persistDecision(store: ArtifactStore): ArtifactRef {
  const request = decisionRequest();
  const decision = sealDecisionDraft({
    request,
    draft: decisionDraft("selected"),
    requestSha256: decisionRequestSha256(request),
    sourceRequestArtifactId: `art_${"e".repeat(64)}`,
    sourceDraftArtifactId: `art_${"f".repeat(64)}`,
    exactInputArtifactIds: [],
  });
  return store.persist({
    metadata: {
      schema_version: 2,
      run_id: "prior-decide",
      phase: "sealing_decision",
      branch_id: null,
      kind: "semantic-core",
      operation_id: "prior-decision",
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Plan generic semantic composition", () => {
  it("declares exactly optional GroundedSynthesisV1 and DecisionV2 ports at 0..1", () => {
    expect(
      PLAN_SKILL_CONTRACT.io.input_ports.map((port) => ({
        name: port.name,
        schema_id: port.schema_id,
        schema_version: port.schema_version_required,
        kind: port.artifact_kind,
        cardinality: [port.min_items, port.max_items],
        semantic_product: port.semantic_product,
      }))
    ).toEqual([
      {
        name: "prior_grounded_synthesis",
        schema_id: "penny.grounded-synthesis.v1",
        schema_version: 1,
        kind: "semantic-core",
        cardinality: [0, 1],
        semantic_product: true,
      },
      {
        name: "prior_decision",
        schema_id: "penny.decision.v2",
        schema_version: 2,
        kind: "semantic-core",
        cardinality: [0, 1],
        semantic_product: true,
      },
    ]);
  });

  it("admits one exact GroundedSynthesisV1 and one exact DecisionV2", () => {
    using store = new ArtifactStore(path.join(temporaryRoot(), "artifacts"));
    const grounded = persistGrounded(store);
    const decision = persistDecision(store);
    expect(() =>
      validateSemanticComposition({
        contract: PLAN_SKILL_CONTRACT,
        inputArtifacts: {
          schema_version: 2,
          artifacts: [
            { slot: "prior_grounded_synthesis", ref: grounded },
            { slot: "prior_decision", ref: decision },
          ],
        },
        artifactReader: store,
      })
    ).not.toThrow();
  });

  it("rejects either port above cardinality one", () => {
    using store = new ArtifactStore(path.join(temporaryRoot(), "artifacts"));
    const grounded = persistGrounded(store);
    const decision = persistDecision(store);
    for (const artifacts of [
      [
        { slot: "prior_grounded_synthesis", ref: grounded },
        { slot: "prior_grounded_synthesis_duplicate", ref: grounded },
      ],
      [
        { slot: "prior_decision", ref: decision },
        { slot: "prior_decision_duplicate", ref: decision },
      ],
    ]) {
      expect(() =>
        validateSemanticComposition({
          contract: PLAN_SKILL_CONTRACT,
          inputArtifacts: { schema_version: 2, artifacts },
          artifactReader: store,
        })
      ).toThrow(/COMPOSITION_PORT_CARDINALITY/u);
    }
  });

  it("rejects stale refs and corrupt semantic bytes", () => {
    using store = new ArtifactStore(path.join(temporaryRoot(), "artifacts"));
    const grounded = persistGrounded(store);
    expect(() =>
      validateSemanticComposition({
        contract: PLAN_SKILL_CONTRACT,
        inputArtifacts: {
          schema_version: 2,
          artifacts: [
            {
              slot: "prior_grounded_synthesis",
              ref: { ...grounded, content_digest: "0".repeat(64) },
            },
          ],
        },
        artifactReader: store,
      })
    ).toThrow(/COMPOSITION_ARTIFACT_STALE/u);

    const corrupt = persistGrounded(store, { schema_version: 1, unexpected: true });
    expect(() =>
      validateSemanticComposition({
        contract: PLAN_SKILL_CONTRACT,
        inputArtifacts: {
          schema_version: 2,
          artifacts: [{ slot: "prior_grounded_synthesis", ref: corrupt }],
        },
        artifactReader: store,
      })
    ).toThrow(CompositionAdmissionError);
  });
});
