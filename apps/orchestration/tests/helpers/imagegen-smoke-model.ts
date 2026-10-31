import type { ArtifactRef } from "../../dist/contracts.js";
import { canonicalJson } from "../../dist/checkpointer.js";
import type { AgentCompletion, AgentInvocation, ModelClient } from "../../dist/model-client.js";

interface Candidate {
  readonly slot: number;
  readonly revision: number;
  readonly image_artifact_id: string;
  readonly image_sha256: string;
}

function generatedImages(invocation: AgentInvocation): readonly ArtifactRef[] {
  return invocation.inputArtifacts.filter((ref) => ref.kind === "generated-image");
}

function currentCandidates(invocation: AgentInvocation): readonly Candidate[] {
  const images = generatedImages(invocation);
  if (images.length === 0) {
    throw new Error("deterministic imagegen smoke critic lacks its exact PNG artifacts");
  }
  return images.map((image, slot) => ({
    slot,
    revision: 0,
    image_artifact_id: image.artifact_id,
    image_sha256: image.content_digest,
  }));
}

function summary(payload: Record<string, unknown>): string {
  return `SUMMARY:${canonicalJson(payload)}`;
}

/**
 * Deterministic provider-free worker for the opt-in backend live smoke.
 *
 * The backend smoke qualifies the real ComfyUI host-operation path, not model vision, so it uses
 * this fixed client. It reports over the exact generated-image artifacts the engine projects into
 * each critic invocation; it never invents an artifact identity and never touches a model.
 */
export class DeterministicImagegenSmokeModel implements ModelClient {
  readonly states: string[] = [];

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.states.push(`${invocation.stateId}:${invocation.agent}`);
    if (invocation.stateId === "framing") {
      return {
        text: summary({
          complete: true,
          needs_clarification: false,
          clarifying_questions: [],
          frame: {
            schema_id: "penny.image-frame.v1",
            schema_version: 1,
            brief: "A calm wordless geometric composition in blue.",
            hard_requirements: ["wordless", "blue geometric forms"],
            material_ambiguities: [],
          },
        }),
      };
    }
    if (invocation.stateId === "composing") {
      return {
        text: summary({
          complete: true,
          needs_clarification: false,
          clarifying_questions: [],
          prompt_plan: {
            schema_id: "penny.image-prompt-plan.v1",
            schema_version: 1,
            positive_prompt: "calm blue geometric forms",
            negative_prompt: "text, letters, words, captions, watermark, typography",
            raw_prompt_preserved: true,
            strategy_delta: null,
          },
        }),
      };
    }
    const candidates = currentCandidates(invocation);
    if (invocation.agent === "vera") {
      return {
        text: summary({
          complete: true,
          report: {
            schema_id: "penny.image-validity-report.v1",
            schema_version: 1,
            review_epoch: 1,
            candidates: candidates.map((candidate) => ({
              candidate,
              approved: true,
              finding_ids: [],
            })),
            findings: [],
          },
        }),
      };
    }
    if (invocation.agent === "carren") {
      return {
        text: summary({
          complete: true,
          report: {
            schema_id: "penny.image-quality-report.v1",
            schema_version: 1,
            review_epoch: 1,
            candidates: candidates.map((candidate) => ({
              candidate,
              approved: true,
              finding_ids: [],
            })),
            findings: [],
            ranking: [...candidates],
          },
        }),
      };
    }
    throw new Error(`unexpected imagegen smoke worker '${invocation.stateId}:${invocation.agent}'`);
  }
}
