import type { ArtifactStore } from "../../src/artifact-store.js";
import type { ArtifactRef } from "../../src/contracts.js";
import type { AgentInvocation } from "../../src/model-client.js";
import {
  validateResearchSemanticDraft,
  type ResearchSemanticDraftV1,
} from "../../src/skill-contracts/research.js";

export interface ResearchSemanticDraftFixtureOptions {
  readonly title?: string;
  readonly executiveSummary?: string;
  readonly claimStatement?: string;
  readonly sectionHeading?: string;
  readonly sectionBody?: string;
  readonly qualified?: boolean;
  readonly blocking?: boolean;
  readonly absentExcerpt?: boolean;
}

function orderedEvidenceArtifacts(refs: readonly ArtifactRef[]): ArtifactRef[] {
  return refs
    .filter((artifact) => artifact.phase === "researching" && artifact.kind === "agent-output")
    .sort((left, right) =>
      `${left.branch_id ?? ""}/${left.operation_id}/${left.artifact_id}`.localeCompare(
        `${right.branch_id ?? ""}/${right.operation_id}/${right.artifact_id}`
      )
    );
}

function containedExcerpt(artifact: ArtifactRef, artifacts: ArtifactStore): string {
  const text = artifacts.readById(artifact.artifact_id).toString("utf8");
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0);
  if (line === undefined) throw new Error(`evidence artifact '${artifact.artifact_id}' is empty`);
  return line.trim();
}

export function researchSemanticDraftFixture(
  invocation: AgentInvocation,
  artifacts: ArtifactStore,
  options: ResearchSemanticDraftFixtureOptions = {}
): ResearchSemanticDraftV1 {
  const evidenceArtifacts = orderedEvidenceArtifacts(invocation.inputArtifacts);
  if (evidenceArtifacts.length === 0) throw new Error("semantic draft fixture has no evidence");
  const evidence = evidenceArtifacts.map((artifact, index) => ({
    source_index: index,
    evidence_artifact_slot: index,
    locator: `fixture-${index + 1}`,
    excerpt:
      options.absentExcerpt === true
        ? `absent-excerpt-${index + 1}`
        : containedExcerpt(artifact, artifacts),
    relation: "supports" as const,
  }));
  return validateResearchSemanticDraft({
    schema_id: "penny.research-semantic-draft.v1",
    schema_version: 1,
    title: options.title ?? "Grounded research synthesis",
    executive_summary:
      options.executiveSummary ?? "The typed semantic draft projects to one grounded core.",
    sources: evidence.map((_item, index) => ({
      source_kind: "primary" as const,
      role: "evidentiary" as const,
      tier: 1,
      title: `Fixture source ${index + 1}`,
      locator: `https://example.invalid/${index + 1}`,
      observed_at: "2026-08-26T00:00:00Z",
    })),
    evidence,
    claims: [
      {
        statement: options.claimStatement ?? "The fixture claim is supported.",
        claim_kind: "fact",
        support_status: options.qualified === true ? "qualified" : "supported",
        confidence: options.qualified === true ? 0.8 : 1,
        evidence_indexes: evidence.map((_item, index) => index),
        qualifications:
          options.qualified === true ? ["The fixture scope remains deliberately bounded."] : [],
      },
    ],
    contradictions: [],
    unresolved_gaps:
      options.blocking === true
        ? [
            {
              statement: "A blocking fixture gap remains.",
              affected_claim_indexes: [0],
              gap_kind: "researchable",
              blocking: true,
            },
          ]
        : [],
    irreducible_uncertainties: [],
    sections: [
      {
        heading: options.sectionHeading ?? "Finding",
        body:
          options.sectionBody ??
          "The host projects stable IDs, verifies excerpts, seals the core, and sends it to Vera.",
        claim_indexes: [0],
        evidence_indexes: evidence.map((_item, index) => index),
      },
    ],
  });
}
