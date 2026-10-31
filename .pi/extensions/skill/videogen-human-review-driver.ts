import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Type, type TSchema } from "typebox";
import type { PlaybookUiInput, PreparedPlaybookUi } from "./playbook-ui.js";
import { executionState } from "@penny/orchestration/videogen/execution-state";
import { openHumanReviewViewer } from "@penny/orchestration/videogen/human-review-viewer";
import {
  ArtifactRefSchema,
  validateContract,
  type ArtifactRef,
} from "@penny/orchestration/contracts";
import { canonicalJson, sha256 } from "@penny/orchestration/canonical-json";
import {
  HumanReviewCandidateV1Schema,
  HumanReviewAnswersV1Schema,
  candidateDigest,
  currentHumanReviewCandidate,
  humanReviewChallenge,
  humanReviewPositive,
  parseHumanReviewAnswers,
  type HumanReviewService,
} from "@penny/orchestration/videogen/human-review";
import { PlaybackReviewV1Schema } from "@penny/orchestration/videogen/stage-contracts";
import { parseVoiceWireJson } from "@penny/orchestration/videogen/voice-json";
import { sameRef, readExact } from "@penny/orchestration/videogen/bounds";
import {
  registerTrustedQuestionnaireTransport,
  type TrustedQuestionnaireBinding,
  renderedQuestionsDigest,
  verifyExecutionOwnerSignature,
  revokeTrustedQuestionnaireTransport,
  type TrustedQuestionnaireQuestion,
} from "./execution-receipts.js";

const eventSchema = Type.Object(
  {
    schema_version: Type.Literal(2),
    origin: Type.Literal("trusted-human-ui"),
    run_id: Type.String(),
    gate_id: Type.String(),
    challenge: Type.String(),
    artifact_ref: ArtifactRefSchema,
    questionnaire_transport_ref: ArtifactRefSchema,
    rendered_questions_digest: Type.String(),
    actor: Type.Literal("human:interactive-questionnaire"),
    timestamp: Type.String(),
    decision: Type.String(),
    response: Type.String({ minLength: 1, maxLength: 32768 }),
    signature: Type.String(),
  },
  { additionalProperties: false }
);

const proposalSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-human-review-proposal.v1"),
    schema_version: Type.Literal(1),
    candidate: HumanReviewCandidateV1Schema,
    assurance: Type.Literal("self_declared_identity_not_authenticated_watch_proof"),
    effect_permission: Type.Literal("none"),
    expires_at_utc: Type.String(),
  },
  { additionalProperties: false }
);
const auditSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-human-review-attestation.v1"),
    schema_version: Type.Literal(1),
    candidate: HumanReviewCandidateV1Schema,
    answers: HumanReviewAnswersV1Schema,
    trusted_ui_event_ref: ArtifactRefSchema,
    trusted_ui_event_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    recorded_at_utc: Type.String(),
    assurance: Type.Literal("trusted_interactive_transport_self_declared_identity_not_watch_proof"),
    effect_permission: Type.Literal("none"),
    disposition: Type.Union([Type.Literal("positive_attestation"), Type.Literal("not_approved")]),
  },
  { additionalProperties: false }
);

export interface HumanReviewSubmission {
  audit_ref: ArtifactRef;
  playback_review_ref: ArtifactRef | null;
  disposition: "positive_attestation" | "not_approved";
}

/** Native parent-only construction. This registers no model tool and grants no authority to a
 * loopback browser or JSON caller. The opaque questionnaire capability can open the existing
 * interactive UI; it cannot attest or sign. Only submit a genuine UI event AFTER the actual user
 * response. Same-process trusted code and same-UID process compromise are outside this boundary. */
export function prepareVideogenHumanReview(input: {
  readonly service: HumanReviewService;
  readonly run_id: string;
  readonly expiry_ms: number;
  readonly playback_device_profile_ref: ArtifactRef;
  readonly completion?: {
    submitted(result: HumanReviewSubmission): { text: string };
    revoke(): void;
  };
}) {
  const { service, run_id, expiry_ms } = input;
  const device = structuredClone(input.playback_device_profile_ref);
  const candidate = currentHumanReviewCandidate(service, run_id),
    digest = candidateDigest(candidate);
  readExact(service.artifacts, service.config.projectId, device, 1024 * 1024);
  if (
    !Number.isSafeInteger(expiry_ms) ||
    expiry_ms < candidate.duration_ms + 60000 ||
    expiry_ms > 30 * 60 * 1000
  )
    throw new Error("trusted review expiry must allow playback and fit questionnaire lifetime");
  const challenge = humanReviewChallenge(),
    operation = `human-review-${randomUUID()}`;
  const started = performance.now(),
    startedUtc = Date.now();
  let consumed = false;
  const persist = (
    kind: string,
    value: unknown,
    upstream: ArtifactRef[],
    schema: TSchema
  ): ArtifactRef =>
    service.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: run_id,
        phase: "human_review",
        branch_id: null,
        kind: `videogen-${kind}`,
        operation_id: `${operation}:${kind}`,
        version: 1,
        producer: "host:videogen-human-review",
        media_type: "application/json",
        content_schema: { schema_id: `penny.videogen-${kind}.v1`, schema_version: 1 },
        parent_ref: null,
        upstream_refs: upstream,
      },
      content: canonicalJson(validateContract(schema, value, "human review product")),
    });
  const proposal = persist(
    "human-review-proposal",
    {
      schema_id: "penny.videogen-human-review-proposal.v1",
      schema_version: 1,
      candidate,
      assurance: "self_declared_identity_not_authenticated_watch_proof",
      effect_permission: "none",
      expires_at_utc: new Date(startedUtc + expiry_ms).toISOString(),
    },
    [
      candidate.master_ref,
      candidate.manifest_ref,
      candidate.native_project_ref,
      candidate.packet_ref,
    ],
    proposalSchema
  );
  const questions: TrustedQuestionnaireQuestion[] = [
    {
      id: "final-playback-attestation",
      label: "Final playback review",
      type: "single",
      options: [],
      allowOther: true,
      prompt: `After personally watching and hearing the exact film, paste your complete local viewer response JSON. No model may answer for you. Negative or unwatched reviews cannot approve. Candidate ${digest}; package ${candidate.package_id}; master revision ${candidate.master_ref.version} SHA-256 ${candidate.master_ref.content_digest}; manifest revision ${candidate.manifest_ref.version} SHA-256 ${candidate.manifest_ref.content_digest}; native revision ${candidate.native_project_ref.version} SHA-256 ${candidate.native_project_ref.content_digest}. This records an attestation, not authenticated watch proof or G5 approval.`,
    },
  ];
  const questionsDigest = renderedQuestionsDigest(questions);
  const submit = (eventValue: unknown): HumanReviewSubmission => {
    if (consumed) throw new Error("human review replay");
    if (performance.now() - started >= expiry_ms) throw new Error("human review expired");
    if (!verifyExecutionOwnerSignature(eventValue))
      throw new Error("trusted interactive human response signature required");
    const event = validateContract(eventSchema, eventValue, "human review signed event");
    if (
      event.run_id !== run_id ||
      event.gate_id !== candidate.gate_id ||
      event.challenge !== challenge ||
      !sameRef(event.artifact_ref, candidate.master_ref) ||
      !sameRef(event.questionnaire_transport_ref, proposal) ||
      event.rendered_questions_digest !== questionsDigest ||
      !Number.isFinite(Date.parse(event.timestamp)) ||
      Date.parse(event.timestamp) < startedUtc ||
      Date.parse(event.timestamp) > Date.now()
    )
      throw new Error("human response binding mismatch");
    const answers = parseHumanReviewAnswers(parseVoiceWireJson(Buffer.from(event.response)));
    if (
      answers.candidate_digest !== digest ||
      !sameRef(answers.playback_device_profile_ref, device)
    )
      throw new Error("human response candidate/device mismatch");
    const checkCurrent = () => {
      if (candidateDigest(currentHumanReviewCandidate(service, run_id)) !== digest)
        throw new Error("human review revision race");
    };
    checkCurrent();
    consumed = true; // one genuine answer, including a negative one; retries must start fresh.
    const positive = humanReviewPositive(answers);
    const signedEvent = persist("human-review-ui-event", event, [proposal], eventSchema);
    const audit = persist(
      "human-review-attestation",
      {
        schema_id: "penny.videogen-human-review-attestation.v1",
        schema_version: 1,
        candidate,
        answers,
        trusted_ui_event_ref: signedEvent,
        trusted_ui_event_sha256: sha256(canonicalJson(event)),
        recorded_at_utc: event.timestamp,
        assurance: "trusted_interactive_transport_self_declared_identity_not_watch_proof",
        effect_permission: "none",
        disposition: positive ? "positive_attestation" : "not_approved",
      },
      [proposal, signedEvent, device],
      auditSchema
    );
    let playback: ArtifactRef | null = null;
    if (positive) {
      const review = validateContract(
        PlaybackReviewV1Schema,
        {
          schema_id: "penny.videogen-playback-review.v1",
          schema_version: 1,
          target_ref: candidate.master_ref,
          target_digest: candidate.master_ref.content_digest,
          reviewer_kind: "human",
          reviewer_id: answers.reviewer_id,
          playback_device_profile_ref: answers.playback_device_profile_ref,
          complete_viewing: answers.complete_viewing,
          heard_audio: answers.heard_audio,
          observations: ["image", "audio", "captions", "overall"].map((criterion) => ({
            time: { numerator: 0, denominator: 1 },
            criterion,
            verdict: "pass",
            note: answers.issues,
          })),
          motion_verdict: answers.motion,
          speech_verdict: answers.speech,
          sync_verdict: answers.sync,
          identity_verdict: answers.identity,
          recorded_at_utc: event.timestamp,
          attestation_ref: audit,
        },
        "human playback attestation"
      );
      playback = persist(
        "playback-review",
        review,
        [audit, candidate.master_ref, device],
        PlaybackReviewV1Schema
      );
    }
    // There is deliberately no saveRun/capture here. Those APIs lack a general atomic CAS for
    // this submission seam. A concurrent revision can leave unselected audit bytes, never select
    // an old candidate or overwrite a newer checkpoint. The caller must serialize later capture.
    checkCurrent();
    return {
      audit_ref: audit,
      playback_review_ref: playback,
      disposition: positive ? "positive_attestation" : "not_approved",
    };
  };
  const capability = registerTrustedQuestionnaireTransport(
    questions,
    {
      runId: run_id,
      gateId: candidate.gate_id,
      challenge,
      artifactRef: { ...candidate.master_ref },
      transportRef: { ...proposal },
      renderedQuestionsDigest: questionsDigest,
    },
    input.completion === undefined
      ? undefined
      : {
          complete(events) {
            if (events.length !== 1) throw new Error("one actual human review answer required");
            const completion = input.completion;
            if (completion === undefined) throw new Error("human review completion unavailable");
            return completion.submitted(submit(events[0]));
          },
          revoke: () => input.completion?.revoke(),
        }
  );
  if (capability === undefined) throw new Error("trusted questionnaire unavailable");
  return {
    candidate: structuredClone(candidate),
    questionnaire_capability: capability,
    proposal_ref: proposal,
    submit,
    revoke: () => revokeTrustedQuestionnaireTransport(capability),
  };
}

const actualDeviceSchema = Type.Object(
  {
    display: Type.String({ minLength: 1, maxLength: 512 }),
    audio_output: Type.String({ minLength: 1, maxLength: 512 }),
    player: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false }
);
const reviewInputsSchema = Type.Union([
  Type.Object(
    {
      master_file_path: Type.String({ minLength: 1, maxLength: 4096 }),
      playback_device_profile_ref: ArtifactRefSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      master_file_path: Type.String({ minLength: 1, maxLength: 4096 }),
      playback_device_profile: actualDeviceSchema,
    },
    { additionalProperties: false }
  ),
]);

/** Registered native UI provider for the final-playback wait only. File/device details are actual
 * caller inputs collected by the existing questionnaire, never inferred from a goal or a model.
 * Its two completion closures and the prepared submission object stay in the running Pi realm. */
export async function prepareVideogenPlaybackUi(
  input: PlaybookUiInput
): Promise<PreparedPlaybookUi | undefined> {
  const { service, directive, release } = input;
  const runId = directive.identity.run_id;
  const run = service.checkpointer.loadRunById(runId);
  if (run?.stateId !== "clarify") return undefined;
  const state = executionState(run);
  if (state.return_state !== "master_critique" || state.slots.some((s) => s.slot === "playback"))
    return undefined;
  const candidate = currentHumanReviewCandidate(service, runId);
  const digest = candidateDigest(candidate);
  const expiry = Math.max(120000, candidate.duration_ms + 300000);
  if (expiry > 30 * 60 * 1000) throw new Error("film exceeds trusted questionnaire review window");
  const operation = `human-review-inputs-${randomUUID()}`;
  const proposal = service.artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: runId,
      phase: "human_review",
      branch_id: null,
      kind: "videogen-human-review-inputs",
      operation_id: operation,
      version: 1,
      producer: "host:videogen-human-review",
      media_type: "application/json",
      parent_ref: null,
      upstream_refs: [candidate.packet_ref, candidate.master_ref],
    },
    content: canonicalJson(
      validateContract(HumanReviewCandidateV1Schema, candidate, "review inputs candidate")
    ),
  });
  const questions: TrustedQuestionnaireQuestion[] = [
    {
      id: "actual-playback-inputs",
      label: "Actual playback setup",
      type: "single",
      options: [],
      allowOther: true,
      prompt: `Supply the actual private absolute path of this selected master (SHA-256 ${candidate.master_ref.content_digest}, ${candidate.master_ref.byte_length} bytes) and the actual playback device setup. Do not ask a model to invent these. Paste one closed JSON object: {"master_file_path":"<actual path>","playback_device_profile":{"display":"<actual screen>","audio_output":"<actual speakers or headphones>","player":"<actual browser/player>"}}. Alternatively replace playback_device_profile with playback_device_profile_ref containing your existing exact artifact ref. Unknown setup? Cancel; no defaults or approval will be recorded. This is setup only, not a viewing attestation.`,
    },
  ];
  const binding: TrustedQuestionnaireBinding = {
    runId,
    gateId: candidate.gate_id,
    challenge: humanReviewChallenge(),
    artifactRef: { ...candidate.master_ref },
    transportRef: { ...proposal },
    renderedQuestionsDigest: renderedQuestionsDigest(questions),
  };
  const startedUtc = Date.now();
  let disposed = false;
  let viewer: Awaited<ReturnType<typeof openHumanReviewViewer>> | undefined;
  let review: ReturnType<typeof prepareVideogenHumanReview> | undefined;
  let capability: string | undefined;
  const timer = setTimeout(release, 30 * 60 * 1000);
  timer.unref();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    if (capability) revokeTrustedQuestionnaireTransport(capability);
    review?.revoke();
    viewer?.close();
  };
  try {
    capability = registerTrustedQuestionnaireTransport(questions, binding, {
      revoke: release,
      async complete(events) {
        try {
          if (disposed || events.length !== 1 || !verifyExecutionOwnerSignature(events[0]))
            throw new Error("actual signed setup response required");
          const event = validateContract(eventSchema, events[0], "review setup UI event");
          if (
            event.run_id !== runId ||
            event.gate_id !== binding.gateId ||
            event.challenge !== binding.challenge ||
            !sameRef(event.artifact_ref, candidate.master_ref) ||
            !sameRef(event.questionnaire_transport_ref, proposal) ||
            event.rendered_questions_digest !== binding.renderedQuestionsDigest ||
            !Number.isFinite(Date.parse(event.timestamp)) ||
            Date.parse(event.timestamp) < startedUtc ||
            Date.parse(event.timestamp) > Date.now() ||
            candidateDigest(currentHumanReviewCandidate(service, runId)) !== digest
          )
            throw new Error("review setup binding changed");
          const actual = validateContract(
            reviewInputsSchema,
            parseVoiceWireJson(Buffer.from(event.response)),
            "actual playback inputs"
          );
          let device: ArtifactRef;
          if ("playback_device_profile_ref" in actual) {
            device = actual.playback_device_profile_ref;
            readExact(service.artifacts, service.config.projectId, device, 1024 * 1024);
          } else {
            if (Object.values(actual.playback_device_profile).some((v) => !v.trim()))
              throw new Error("actual device descriptions required");
            device = service.artifacts.persist({
              metadata: {
                schema_version: 2,
                run_id: runId,
                phase: "human_review",
                branch_id: null,
                kind: "videogen-playback-device",
                operation_id: `${operation}:device`,
                version: 1,
                producer: "host:videogen-human-review",
                media_type: "application/json",
                parent_ref: null,
                upstream_refs: [proposal],
              },
              content: canonicalJson(
                validateContract(
                  actualDeviceSchema,
                  actual.playback_device_profile,
                  "actual playback device"
                )
              ),
            });
          }
          review = prepareVideogenHumanReview({
            service,
            run_id: runId,
            expiry_ms: expiry,
            playback_device_profile_ref: device,
            completion: {
              revoke: release,
              submitted(result) {
                try {
                  if (disposed) throw new Error("review session closed");
                  if (result.playback_review_ref === null)
                    return {
                      text: `Playback NOT approved. Audit ${result.audit_ref.artifact_id}. The run remains blocked; no playback record was captured and no G5 answer was made.`,
                    };
                  // Synchronous same-owner recheck and existing capture, with no intervening await.
                  if (candidateDigest(currentHumanReviewCandidate(service, runId)) !== digest)
                    throw new Error("human review revision race before capture");
                  service.captureVideogenPlaybackForRun(runId, result.playback_review_ref);
                  return {
                    text: `Human playback attestation captured: ${result.playback_review_ref.artifact_id}. Audit ${result.audit_ref.artifact_id}. This is not G5 approval. The original engine clarification still requires its separate response; then G5 requires a separate actual human decision.`,
                  };
                } finally {
                  release();
                }
              },
            },
          });
          viewer = await openHumanReviewViewer({
            service,
            run_id: runId,
            master_file: {
              path: actual.master_file_path,
              sha256: candidate.master_ref.content_digest,
              max_bytes: candidate.master_ref.byte_length,
            },
            playback_device_profile_ref: device,
            expiry_ms: expiry,
            max_requests: 4096,
            max_served_bytes: Math.min(
              16 * 1024 * 1024 * 1024,
              Math.max(1024 * 1024, candidate.master_ref.byte_length * 8)
            ),
          });
          if (disposed) {
            viewer.close();
            throw new Error("review session closed during viewer preparation");
          }
          void viewer.closed.then(release);
          clearTimeout(timer); // viewer expiry now owns the same resource lifetime.
          return {
            text: `Read-only exact-film viewer: ${viewer.url}\nWatch the entire film with sound using the declared actual setup. Prepare your local response, then invoke questionnaire(${JSON.stringify({ trustedTransportCapability: review.questionnaire_capability })}). Only the actual user may answer. The native completion records the signed answer automatically. No model answers, browser POSTs or G5 approval.`,
          };
        } catch (error) {
          release();
          throw error;
        }
      },
    });
    if (capability === undefined) throw new Error("trusted setup questionnaire unavailable");
    return {
      capability,
      text: "Actual file and playback device inputs are required before a viewer can open. Answer the trusted setup questionnaire yourself; no model may supply these inputs. Its native completion will return the read-only URL and a new one-time review questionnaire capability.",
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
