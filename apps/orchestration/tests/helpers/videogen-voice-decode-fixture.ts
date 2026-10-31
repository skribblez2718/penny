import { canonicalJson, sha256 } from "../../dist/canonical-json.js";
import type { ArtifactRef, InvokeHostOperationDirectiveV1 } from "../../dist/contracts.js";
import { HostOperationRuntimeOwner } from "../../dist/host-operations/owner.js";
import {
  hostOperationPolicyBinding,
  type HostOperationAdapterV1,
} from "../../dist/host-operations/contracts.js";
import { runtimeRegistrationSha256 } from "../../dist/playbooks/registry.js";
import { AudioSourceDecodeCustody } from "../../dist/videogen/audio-sources.js";
import { MediaEvidenceCustody } from "../../dist/videogen/media-evidence.js";
import {
  RAW_MEDIA_REQUEST_CONTRACT,
  RAW_MEDIA_RESULT_CONTRACT,
  MEDIA_PCM_CONTRACT,
  type RawMediaDecodeResultV1,
} from "../../dist/videogen/media-contracts.js";
import { inspectCanonicalPcmWav, measurePcm16 } from "../../dist/videogen/media-decode.js";
import { rationalTime } from "../../dist/videogen/rational-time.js";
import {
  MEDIA_POLICY,
  MEDIA_LIMITS,
  MEDIA_SELECTION,
  required,
} from "./videogen-media-fixtures.js";
import type { VoiceFixture } from "./videogen-voice-fixture.js";

/** Synthetic provider-free PCM fixture, through actual owner/journal/settlement. This is not a
 * generator service or deployed decoder qualification. PCM16 sample decode is checked byte-for-byte
 * by the existing MediaEvidenceCustody, separately from this fixture adapter. */
export async function decodeVoiceFixture(f: VoiceFixture, source: ArtifactRef) {
  const bytes = f.store.read(source),
    pcm = inspectCanonicalPcmWav(bytes, MEDIA_POLICY);
  const selectionRef = f.json(MEDIA_SELECTION, MEDIA_SELECTION.schema_id),
    duration = rationalTime(BigInt(pcm.samples), BigInt(pcm.sample_rate));
  const spans = [{ start: { numerator: 0, denominator: 1 }, end: duration }];
  const request = {
    schema_id: "penny.videogen-raw-media-decode-request.v1",
    schema_version: 1,
    operation_id: "voice-decode",
    media_ref: source,
    decode_policy_ref: f.media_policy_ref,
    required_spans: spans,
    frame_selection_ref: selectionRef,
    audio_policy: "measure_pcm",
  };
  const ref0 = f.json(request, request.schema_id),
    ref = f.store.persist({
      metadata: {
        ...f.store.metadata(ref0),
        kind: RAW_MEDIA_REQUEST_CONTRACT.artifact_kind,
        operation_id: "voice-decode-request",
      },
      content: canonicalJson(request),
    });
  const backend = sha256("fixture-PCM-worker"),
    parent = required(f.directive);
  const { effect_identity: _identity, effect_intent_ref: _intent, ...base } = parent;
  const directive: InvokeHostOperationDirectiveV1 = {
    ...base,
    state_id: "decode-fixture",
    operation_id: request.operation_id,
    operation_kind: "media_decode_extract",
    request_ref: ref,
    request_sha256: ref.content_digest,
    input_artifacts: {
      schema_version: 2,
      artifacts: [
        { slot: "media", ref: source },
        { slot: "decode-policy", ref: f.media_policy_ref },
        { slot: "frame-selection", ref: selectionRef },
      ],
    },
    expected_result: RAW_MEDIA_RESULT_CONTRACT,
    policy_binding: hostOperationPolicyBinding(f.decode_declaration, backend),
  };
  const run = required(f.checkpointer.loadRunById(f.run_id));
  run.status = "running";
  run.transition(directive.state_id);
  run.pendingDirective = directive;
  f.checkpointer.saveRun(run, "fixture_decode", {});
  const disposition = {
    outcome: "completed",
    remote_disposition: "proven_terminal",
    lease_disposition: "released",
    retryable: false,
    reason_code: null,
  } as const;
  const adapter: HostOperationAdapterV1 = {
    adapter_id: f.decode_declaration.adapter_id,
    inspectRequest: () => ({
      schema_version: 1,
      operation_kind: "media_decode_extract",
      adapter_id: f.decode_declaration.adapter_id,
      backend_binding_id: f.decode_declaration.backend_binding_id,
      backend_key_sha256: backend,
    }),
    run: async (c) => {
      c.beginSubmission();
      c.recordRemoteAccepted("fixture-PCM");
      const result: RawMediaDecodeResultV1 = {
        schema_id: "penny.videogen-raw-media-decode-result.v1",
        schema_version: 1,
        operation_id: request.operation_id,
        source_ref: source,
        request_sha256: ref.content_digest,
        policy_sha256: f.media_policy_ref.content_digest,
        selection_sha256: selectionRef.content_digest,
        required_spans: spans,
        decode_scope: "entire_source_including_preroll",
        container_policy: MEDIA_POLICY.metadata_policy,
        video: null,
        audio: {
          codec: "canonical_pcm",
          channels: pcm.channels === 1 ? "mono" : "stereo",
          sample_rate: pcm.sample_rate,
          decoded_sample_count: pcm.samples,
          duration,
          spans: [
            { start_sample: 0, end_sample: pcm.samples, slot: "pcm-0", ...measurePcm16(pcm.data) },
          ],
        },
        outputs: [
          {
            slot: "pcm-0",
            media_type: "audio/wav",
            sha256: sha256(bytes),
            byte_length: bytes.length,
          },
        ],
        qualification: "raw_decode_only_not_playback_or_production",
      };
      const content = canonicalJson(result);
      c.recordFetched({
        schema_version: 1,
        content_sha256: sha256(content),
        byte_length: Buffer.byteLength(content),
        item_count: 1,
        poll_count: 0,
      });
      return {
        disposition,
        ...c.persist({
          disposition,
          operation_result: {
            contract: RAW_MEDIA_RESULT_CONTRACT,
            media_type: "application/json",
            content,
          },
          outputs: [{ contract: MEDIA_PCM_CONTRACT, media_type: "audio/wav", content: bytes }],
        }),
      };
    },
  };
  const owner = new HostOperationRuntimeOwner({
    projectId: f.project_id,
    checkpointer: f.checkpointer,
    artifacts: f.store,
    leaseAuthority: f.leases,
    adapters: new Map([[adapter.adapter_id, adapter]]),
  });
  await owner.dispatch(f.engine, directive);
  const record = required(
    f.checkpointer.hostOperationCallForDirective(
      f.run_id,
      directive.state_id,
      1,
      directive.operation_id
    )
  );
  const bindings = {
    state_root: f.state_root,
    project_id: f.project_id,
    store: f.store,
    checkpointer: f.checkpointer,
    leases: f.leases,
    limits: MEDIA_LIMITS,
    registration_sha256: runtimeRegistrationSha256(f.registration),
    declaration: f.decode_declaration,
    backend_key_sha256: backend,
    policy_ref: f.media_policy_ref,
  };
  const decode = new MediaEvidenceCustody(bindings),
    audio = new AudioSourceDecodeCustody(bindings);
  decode.materialize(record.operation_record_id);
  return { decode, audio, bindings, operation_record_id: record.operation_record_id };
}
