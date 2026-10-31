import { canonicalJson } from "../canonical-json.js";
import type { ArtifactHostStore } from "../artifact-store.js";
import type { ArtifactRef } from "../contracts.js";
import {
  checkDefinitionSupportLocator,
  definitionRequestSourceItems,
  validateDefinitionClarificationResponse,
  validateDefinitionClarificationChallenge,
  validateDefinitionFrameV2,
  type DefinitionFrameV2,
  type DefinitionRequestV1,
  type SpecificationDraftV2,
  type SpecificationV1,
} from "./define.js";
import { specificationProfile } from "./define-profiles.js";
import {
  assertDefinitionAllowedUse,
  type DefinitionAllowedUseV1,
  type EvidenceAdmissionV2,
} from "./evidence-admission.js";

function exactBytes(reader: ArtifactHostStore, ref: ArtifactRef): Buffer {
  const actual = reader.refById(ref.artifact_id);
  if (actual === undefined || canonicalJson(actual) !== canonicalJson(ref)) {
    throw new Error("Define support ref is not the exact selected manifest ref");
  }
  return reader.readById(ref.artifact_id);
}

/** Read selected support bytes, resolve each use against its exact target and require material readiness. */
export function validateDefinitionSupport(input: {
  readonly reader: ArtifactHostStore;
  readonly request: DefinitionRequestV1;
  readonly frame: DefinitionFrameV2;
  readonly admission: EvidenceAdmissionV2;
  readonly draft: SpecificationDraftV2;
  readonly product: SpecificationV1;
}): void {
  const { reader, request, frame, admission, draft, product } = input;
  if (
    frame.request_id !== request.request_id ||
    frame.profile.profile_id !== product.profile.profile_id
  ) {
    // The frame digest is verified by the trace projector against its exact stored ref.
    throw new Error("Define support frame/request/product binding differs");
  }
  const questions = new Map(frame.questions.map((q) => [q.question_id, q]));
  const sources = definitionRequestSourceItems(request);
  const uncertaintyOrdinals = new Set(
    sources.filter((s) => s.kind === "uncertainty").map((s) => s.ordinal)
  );
  const categories = new Set([
    ...request.standard_hints.map((h) => h.category),
    ...specificationProfile(frame.profile.profile_id).required_standard_categories,
  ]);
  const answeredBySlot = new Map<number, Set<string>>();
  admission.support_slots.forEach((slot, index) => {
    const bytes = exactBytes(reader, slot.ref);
    if (slot.role === "caller_response") {
      if (slot.challenge_ref === null) throw new Error("caller support lacks challenge");
      const challengeBytes = exactBytes(reader, slot.challenge_ref);
      const challengeValue: unknown = JSON.parse(challengeBytes.toString("utf8"));
      const selectedFrameRef = reader
        .metadata(slot.challenge_ref)
        .upstream_refs.find((ref) => ref.kind === "definition-frame");
      if (selectedFrameRef === undefined)
        throw new Error("caller support challenge has no frame ref");
      const frameBytes = exactBytes(reader, selectedFrameRef);
      const orientationRef = reader
        .metadata(selectedFrameRef)
        .upstream_refs.find(
          (ref) => ref.kind === "agent-output" && ref.phase === "framing_definition"
        );
      const requestRef = reader.refById(product.source_lineage.request_artifact_id);
      if (requestRef === undefined || orientationRef === undefined)
        throw new Error("caller support frame lacks operands");
      const priorFrame = validateDefinitionFrameV2(
        JSON.parse(frameBytes.toString("utf8")),
        request,
        requestRef,
        orientationRef
      );
      if (canonicalJson(priorFrame) !== frameBytes.toString("utf8"))
        throw new Error("caller support frame is not canonical");
      const challenge = validateDefinitionClarificationChallenge(challengeValue, priorFrame);
      if (
        canonicalJson(challenge) !== challengeBytes.toString("utf8") ||
        canonicalJson(challenge.request_ref) !==
          canonicalJson(reader.refById(input.product.source_lineage.request_artifact_id)) ||
        canonicalJson(challenge.frame_ref) !== canonicalJson(selectedFrameRef) ||
        challenge.question_ids.some((id) => !questions.has(id))
      ) {
        throw new Error("caller support challenge does not bind the current questions");
      }
      const response = validateDefinitionClarificationResponse({
        value: JSON.parse(bytes.toString("utf8")),
        challenge,
        challengeRef: slot.challenge_ref,
      });
      if (canonicalJson(response) !== bytes.toString("utf8")) {
        throw new Error("caller response support is not canonical");
      }
      answeredBySlot.set(
        index,
        new Set(
          response.answers.filter((a) => a.disposition === "answered").map((a) => a.question_id)
        )
      );
    }
    for (const use of slot.allowed_uses) {
      if (use.kind === "standard_category") {
        if (slot.role === "caller_response" || !categories.has(use.category)) {
          throw new Error("Define support standard category is not admitted for this role");
        }
      } else {
        const question =
          use.kind === "request_uncertainty"
            ? frame.questions.find((q) => q.source_item_index === use.source_item_index)
            : questions.get(use.question_id);
        if (
          question === undefined ||
          (use.kind === "request_uncertainty" && !uncertaintyOrdinals.has(use.source_item_index)) ||
          (use.kind === "discovered_question" && question.source_item_index !== null) ||
          (slot.role === "caller_response" &&
            (question.owner !== "caller" ||
              !answeredBySlot.get(index)?.has(question.question_id))) ||
          (slot.role !== "caller_response" && question.owner !== "evidence")
        ) {
          throw new Error("Define support question use has wrong owner, target, or response");
        }
      }
    }
  });
  const claims = new Map(draft.support_claims.map((claim) => [canonicalJson(claim.target), claim]));
  for (const question of frame.questions) {
    const target =
      question.source_item_index === null
        ? { kind: "discovered_question", question_id: question.question_id }
        : { kind: "request_uncertainty", source_item_index: question.source_item_index };
    const claim = claims.get(canonicalJson(target));
    if (claim === undefined || !("status" in claim)) {
      throw new Error("Define question has no target-specific support claim");
    }
    const resolved = claim.status === "resolved" && claim.support.length > 0;
    if (claim.status === "resolved" && !resolved)
      throw new Error("resolved Define question lacks support");
    if (!resolved && question.material && product.disposition === "ready") {
      throw new Error("material Define question remains unresolved in ready product");
    }
    if (
      question.material &&
      !resolved &&
      !product.open_questions.some((item) => item.question === question.question && item.blocking)
    ) {
      throw new Error("pending material Define question is missing from blocked product");
    }
  }
  for (const claim of draft.support_claims) {
    let use: DefinitionAllowedUseV1;
    if (claim.target.kind === "standard") {
      const standard = draft.specification.standards_status[claim.target.standard_index];
      if (standard === undefined) throw new Error("Define standard support target is out of range");
      use = { kind: "standard_category", category: standard.category };
      if (standard.status !== "satisfied_with_evidence" && claim.support.length > 0) {
        throw new Error("non-satisfied standard cannot claim evidence support");
      }
      if (standard.status === "satisfied_with_evidence" && claim.support.length === 0) {
        throw new Error("satisfied standard has no evidence support");
      }
    } else if (claim.target.kind === "request_uncertainty") {
      use = claim.target;
      if (!uncertaintyOrdinals.has(use.source_item_index))
        throw new Error("unknown uncertainty target");
    } else {
      use = claim.target;
      if (!questions.has(use.question_id)) throw new Error("unknown discovered question target");
    }
    for (const selector of claim.support) {
      const slot = admission.support_slots[selector.support_slot];
      if (slot === undefined) throw new Error("Define support slot is outside the admission");
      assertDefinitionAllowedUse(slot, use);
      if (claim.target.kind === "standard" && slot.role === "caller_response") {
        throw new Error("caller response cannot support a standard");
      }
      checkDefinitionSupportLocator(selector.locator, exactBytes(reader, slot.ref));
    }
  }
  draft.specification.standards_status.forEach((standard, index) => {
    if (
      standard.status === "satisfied_with_evidence" &&
      !claims.has(canonicalJson({ kind: "standard", standard_index: index }))
    ) {
      throw new Error("satisfied standard lacks a particular support claim");
    }
  });
}
