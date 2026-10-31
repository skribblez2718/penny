import { VoiceApiObservationCollector } from "./voice-api-observations.js";
import {
  VOICE_API_ADAPTER_ID,
  VOICE_API_RAW_RESULT,
  VoiceApiProfileSchema,
  type VoiceApiProfile,
} from "./voice-api-contracts.js";
import { VoiceManagedRelay } from "./voice-managed-relay.js";
import { readVoiceSemantic } from "./voice-json.js";
import { VoiceStudioObservationCollector } from "./voice-studio-observations.js";
import { verifyHostEffectBinding } from "../host-operations/effect-protocol.js";
import { type TSchema, type Static } from "typebox";
import { ArtifactStore } from "../artifact-store.js";
import { Checkpointer } from "../checkpointer.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef, InvokeHostOperationDirectiveV1 } from "../contracts.js";
import { HostOperationCapacityRuntimeBinding } from "../host-operations/capacity-runtime.js";
import { HostOperationCapacityAuthority } from "../host-operations/capacity-authority.js";
import { hostCapacityWorkerKey } from "../host-operations/capacity-contracts.js";
import { type HostOperationCallRecordV1 } from "../host-operations/contracts.js";
import type { HostOperationUseValidatorV1 } from "../host-operations/owner.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import { readExact, sameRef, type FoundationLimitsV1 } from "./bounds.js";
import { checkGateApproval } from "./gates.js";
import { readVideogenOwnerSelection, VideogenOwnerSelection } from "./owner-selection.js";
import {
  checkRights,
  validateDependencyLedger,
  DependencyLedgerV1Schema,
} from "./rights-ledger.js";
import {
  AssetIntentV1Schema,
  ScriptV1Schema,
  BudgetReservationV1Schema,
  validateAssetIntent,
  validateBudgetReservation,
  validateScript,
  METER_UNITS,
  MeterSchema,
} from "./foundation-contracts.js";
import {
  MediaDecodePolicyV1Schema,
  parseMediaJson,
  validateMediaPolicy,
} from "./media-contracts.js";
import { validateRationalTime } from "./rational-time.js";
import {
  VoiceStudioProfileV1Schema,
  VoiceStudioJobRequestV1Schema,
  VoiceStudioChunkPlanV1Schema,
  VoiceStudioVoiceV1Schema,
  VoiceStudioReadinessV1Schema,
  VoiceStudioCoverageV1Schema,
  VoiceStudioCorrelationV1Schema,
  VoiceStudioRawResultV1Schema,
  VOICE_STUDIO_ADAPTER_ID,
  VOICE_STUDIO_RAW_RESULT,
  type VoiceStudioProfileV1,
  type VoiceStudioJobRequestV1,
  type VoiceStudioCorrelationV1,
  type VoiceStudioNarrationV1,
} from "./voice-studio-contracts.js";
import { validateVoiceStudioTransport } from "./voice-studio-transport.js";

export function voiceStudioInputs(
  r: VoiceStudioJobRequestV1,
  p: Pick<VoiceStudioProfileV1, "media_policy_ref">
) {
  return [
    { slot: "profile", ref: r.profile_ref },
    { slot: "script", ref: r.script_ref },
    { slot: "chunk-plan", ref: r.chunk_plan_ref },
    { slot: "voice", ref: r.voice_ref },
    { slot: "voice-rights", ref: r.voice_rights_ref },
    { slot: "script-rights", ref: r.script_rights_ref },
    { slot: "consent", ref: r.consent_ref },
    { slot: "build", ref: r.service_build_ref },
    { slot: "ledger", ref: r.selected_ledger_ref },
    { slot: "budget", ref: r.budget_reservation_ref },
    { slot: "decode-policy", ref: p.media_policy_ref },
    { slot: "queue-policy", ref: r.policy_refs.queue_policy_ref.ref },
    { slot: "inactivity-policy", ref: r.policy_refs.inactivity_policy_ref.ref },
    { slot: "cleanup-policy", ref: r.policy_refs.cleanup_policy_ref.ref },
  ].filter(
    (entry, index, all) =>
      all.findIndex((x) => x.ref.artifact_id === entry.ref.artifact_id) === index
  );
}
export interface VoiceStudioAuthorityBindingsV1 {
  readonly store: ArtifactStore;
  readonly checkpointer: Checkpointer;
  /** Sole current approval/rights authority: concrete checkpoint owner, never a projection. */
  readonly owner: VideogenOwnerSelection;
  readonly capacity: HostOperationCapacityRuntimeBinding;
  readonly capacity_authority: HostOperationCapacityAuthority;
  readonly profile_ref: ArtifactRef;
  readonly profile: VoiceStudioProfileV1 | VoiceApiProfile;
  readonly transport: unknown;
  readonly limits: FoundationLimitsV1;
  readonly observations: VoiceStudioObservationCollector | VoiceApiObservationCollector;
  readonly assurance?: "trusted_local_api";
  readonly managed_relay?: VoiceManagedRelay;
}
/** Concrete capability over existing owners, not an approve callback, journal, or issuer. */
export class VoiceStudioAuthority implements HostOperationUseValidatorV1 {
  readonly profile: VoiceStudioProfileV1 | VoiceApiProfile;
  readonly transport: ReturnType<typeof validateVoiceStudioTransport>;
  readonly backend_key_sha256: string;
  readonly #bindings: VoiceStudioAuthorityBindingsV1;
  readonly #projectId: string;
  get bindings(): VoiceStudioAuthorityBindingsV1 {
    return this.#bindings;
  }
  constructor(bindings: VoiceStudioAuthorityBindingsV1) {
    if (
      new.target !== VoiceStudioAuthority ||
      !(bindings.store instanceof ArtifactStore) ||
      !(bindings.checkpointer instanceof Checkpointer) ||
      !(bindings.capacity instanceof HostOperationCapacityRuntimeBinding) ||
      !(bindings.capacity_authority instanceof HostOperationCapacityAuthority)
    )
      throw new Error("Voice Studio requires concrete existing owner capabilities");
    const b = bindings;
    const host = readVideogenOwnerSelection(b.owner);
    if (host.gate.store !== b.store || host.gate.checkpointer !== b.checkpointer)
      throw new Error("Voice Studio owner/project binding mismatch");
    this.#bindings = Object.freeze({ ...b });
    this.#projectId = host.gate.project_id;
    b.store.assertBoundProject(host.gate.project_id);
    b.checkpointer.assertBoundProject(host.gate.project_id);
    this.profile = structuredClone(
      validateSkillSchema(
        b.assurance === "trusted_local_api" ? VoiceApiProfileSchema : VoiceStudioProfileV1Schema,
        b.profile,
        "Voice profile"
      )
    );
    if (
      canonicalJson(
        this.read(
          b.profile_ref,
          b.assurance === "trusted_local_api" ? VoiceApiProfileSchema : VoiceStudioProfileV1Schema,
          this.profile.schema_id
        )
      ) !== canonicalJson(this.profile)
    )
      throw new Error("Voice Studio profile drift");
    this.transport = Object.freeze(validateVoiceStudioTransport(b.transport));
    if (b.assurance === "trusted_local_api")
      VoiceApiObservationCollector.require(b.observations, b.owner, b.profile_ref, this.transport);
    else
      VoiceStudioObservationCollector.require(
        b.observations,
        b.owner,
        b.profile_ref,
        this.transport
      );
    this.backend_key_sha256 = hostCapacityWorkerKey(this.profile.process_worker_id);
    Object.freeze(this);
  }
  /** Each call reloads the actual same-project checkpoint, including revocation and wall clock. */
  current() {
    const b = this.#bindings,
      host = readVideogenOwnerSelection(b.owner);
    if (host.gate.store !== b.store || host.gate.checkpointer !== b.checkpointer)
      throw new Error("Voice Studio owner/project binding mismatch");
    return host;
  }
  read<T extends TSchema>(ref: ArtifactRef, schema: T, schemaId: string): Static<T> {
    const b = this.bindings;
    return readVoiceSemantic({
      store: b.store,
      project_id: this.#projectId,
      ref,
      schema,
      schema_id: schemaId,
      limits: b.limits,
    });
  }
  parseRequest(bytes: Uint8Array): VoiceStudioJobRequestV1 {
    return parseMediaJson(VoiceStudioJobRequestV1Schema, bytes, this.bindings.limits);
  }
  readCorrelation(text: string): VoiceStudioCorrelationV1 {
    return parseMediaJson(VoiceStudioCorrelationV1Schema, Buffer.from(text), this.bindings.limits);
  }
  validateUse(input: Parameters<HostOperationUseValidatorV1["validateUse"]>[0]): void {
    const request = this.parseRequest(input.request_bytes);
    this.validateRequest(request, input.directive);
    if (this.bindings.assurance !== "trusted_local_api" && !this.bindings.managed_relay)
      this.readiness();
    const journal = this.bindings.checkpointer.hostOperationCallForDirective(
      input.directive.identity.run_id,
      input.directive.state_id,
      input.directive.attempt,
      input.directive.operation_id
    );
    if (
      this.bindings.assurance !== "trusted_local_api" &&
      journal?.operation_result_ref &&
      journal.disposition?.outcome === "completed"
    ) {
      const raw = this.read(
        journal.operation_result_ref,
        VoiceStudioRawResultV1Schema,
        "penny.videogen-voice-studio-raw-result.v1"
      );
      if (!sameRef(this.coverage(raw.correlation, request, raw.narration), raw.coverage_ref))
        throw new Error("Voice Studio current coverage custody changed");
    }
  }
  validateRequest(r: VoiceStudioJobRequestV1, d: InvokeHostOperationDirectiveV1) {
    const b = this.bindings,
      p = this.profile,
      host = this.current(),
      { gate, rights } = host;
    if (sha256(canonicalJson(r)) !== d.request_sha256)
      throw new Error("Voice Studio request bytes/directive drift");
    if (
      canonicalJson(
        this.read(
          b.profile_ref,
          b.assurance === "trusted_local_api" ? VoiceApiProfileSchema : VoiceStudioProfileV1Schema,
          p.schema_id
        )
      ) !== canonicalJson(p)
    )
      throw new Error("Voice Studio host profile drift");
    const effect = verifyHostEffectBinding(b.store, gate.project_id, d);
    const expectedContract: unknown =
      effect === undefined
        ? null
        : JSON.parse(
            readExact(
              b.store,
              gate.project_id,
              effect.expected_output_contract_ref,
              b.limits.max_json_bytes
            ).toString()
          );
    if (
      !effect ||
      !d.effect_identity ||
      !sameRef(effect.gate_decision_ref, r.gate_decision_ref) ||
      !sameRef(effect.budget_reservation_ref, r.budget_reservation_ref) ||
      !effect.profile_snapshot_ref ||
      !sameRef(effect.profile_snapshot_ref, r.profile_ref) ||
      !sameRef(d.effect_identity.predecessor_ref, r.asset_intent_ref) ||
      canonicalJson(expectedContract) !==
        canonicalJson(
          b.assurance === "trusted_local_api" ? VOICE_API_RAW_RESULT : VOICE_STUDIO_RAW_RESULT
        )
    )
      throw new Error("Voice Studio exact request-before-intent binding required");
    validateRationalTime(r.placement);
    if (
      r.placement.numerator < 0 ||
      r.operation_id !== d.operation_id ||
      d.identity.run_id !== gate.run_id ||
      d.operation_kind !== "voice_job" ||
      d.policy_binding.adapter_id !==
        (b.assurance === "trusted_local_api" ? VOICE_API_ADAPTER_ID : VOICE_STUDIO_ADAPTER_ID) ||
      d.policy_binding.backend_binding_id !== p.backend_binding_id ||
      d.policy_binding.backend_key_sha256 !== this.backend_key_sha256 ||
      !sameRef(r.profile_ref, b.profile_ref) ||
      !sameRef(r.service_build_ref, p.service_build_ref) ||
      r.voice_id !== p.voice_id ||
      canonicalJson(d.input_artifacts.artifacts) !== canonicalJson(voiceStudioInputs(r, p))
    )
      throw new Error("Voice Studio exact directive/profile/voice binding");
    for (const { ref } of d.input_artifacts.artifacts)
      readExact(b.store, gate.project_id, ref, r.limits.max_input_bytes);
    if (
      d.input_artifacts.artifacts.reduce((n, x) => n + x.ref.byte_length, 0) >
        r.limits.max_input_bytes ||
      r.limits.max_output_bytes < p.limits.max_wav_bytes
    )
      throw new Error("Voice Studio input/output allowance");
    const script = validateScript(
      this.read(r.script_ref, ScriptV1Schema, "penny.videogen-script.v1"),
      b.limits
    );
    const plan = this.read(
      r.chunk_plan_ref,
      VoiceStudioChunkPlanV1Schema,
      "penny.videogen-voice-studio-chunk-plan.v1"
    );
    const lines = [...script.scenes.flatMap((s) => s.ordered_lines), ...script.narration_lines];
    const source = lines.map((l) => l.text).join("\n");
    let offset = 0;
    if (
      !sameRef(plan.script_ref, r.script_ref) ||
      source !== plan.source_text ||
      source.length > 500000 ||
      Buffer.byteLength(source) > p.limits.max_text_bytes ||
      plan.chunks.length > p.limits.max_chunks ||
      new Set(r.expected_chunk_ids).size !== r.expected_chunk_ids.length ||
      canonicalJson(plan.chunks.map((c) => c.chunk_id)) !== canonicalJson(r.expected_chunk_ids)
    )
      throw new Error("Voice Studio script/chunk plan mismatch");
    for (const chunk of plan.chunks) {
      const covered = lines.slice(offset, offset + chunk.line_ids.length);
      offset += covered.length;
      if (
        canonicalJson(covered.map((l) => l.line_id)) !== canonicalJson(chunk.line_ids) ||
        covered.map((l) => l.text).join("\n") !== chunk.text ||
        chunk.text.trim().split(/\s+/u).length > 500
      )
        throw new Error("Voice Studio exact ordered chunk text required");
    }
    if (offset !== lines.length || plan.chunks.map((c) => c.text).join("\n") !== source)
      throw new Error("Voice Studio incomplete script coverage");
    const voice = this.read(
      r.voice_ref,
      VoiceStudioVoiceV1Schema,
      "penny.videogen-voice-studio-voice.v1"
    );
    if (voice.id !== p.voice_id || sha256(canonicalJson(voice)) !== p.voice_sha256)
      throw new Error("Voice Studio voice snapshot drift");
    const voiceRights = checkRights(rights, r.voice_ref, r.voice_rights_ref, "preview");
    const textRights = checkRights(rights, r.script_ref, r.script_rights_ref, "preview");
    if (
      voiceRights.subject_kind !== "voice" ||
      textRights.subject_kind !== "text" ||
      !voiceRights.consent_refs.some((ref) => sameRef(ref, r.consent_ref))
    )
      throw new Error("Voice Studio consent/text rights mismatch");
    const { packet } = checkGateApproval(gate, "G1", r.gate_decision_ref);
    if (packet.kind !== "approval" || !packet.effect_scope.kinds.includes("voice_job"))
      throw new Error("Voice Studio G1 scope absent");
    const intent = validateAssetIntent(
      this.read(r.asset_intent_ref, AssetIntentV1Schema, "penny.videogen-asset-intent.v1"),
      b.limits
    );
    const proposedRefs = packet.presented.filter((x) => x.role === "asset-intent");
    if (intent.scope_status !== "approved")
      throw new Error("Voice Studio approved intent required");
    const { scope_status: ignored, gate_scope_ref: ignoredGate, ...expected } = intent;
    void ignored;
    void ignoredGate;
    if (
      intent.scope_status !== "approved" ||
      !sameRef(intent.gate_scope_ref, r.gate_decision_ref) ||
      intent.source !== "voice_studio" ||
      intent.purpose !== (r.scope === "performance" ? "performance" : "voice_preview") ||
      !sameRef(intent.consent_ref, r.consent_ref) ||
      !sameRef(intent.rights_ref, r.voice_rights_ref) ||
      ![r.script_ref, r.chunk_plan_ref, r.voice_ref].every((ref) =>
        intent.input_refs.some((x) => sameRef(x, ref))
      ) ||
      !proposedRefs.some(({ ref }) => {
        const proposal = this.read(ref, AssetIntentV1Schema, "penny.videogen-asset-intent.v1");
        const { scope_status, ...fields } = proposal;
        return scope_status === "proposed" && canonicalJson(fields) === canonicalJson(expected);
      })
    )
      throw new Error("Voice Studio intent differs from exact G1 proposal");
    const selected = b.checkpointer.loadRunById(gate.run_id)?.selectedArtifacts ?? [];
    const approved = host.approved_intent_refs
      .map((ref) => ({
        ref,
        value: validateAssetIntent(
          this.read(ref, AssetIntentV1Schema, "penny.videogen-asset-intent.v1"),
          b.limits
        ),
      }))
      .filter((x) => x.value.asset_id === intent.asset_id && x.value.scope_status === "approved");
    if (approved.length !== 1 || !approved.some((x) => sameRef(x.ref, r.asset_intent_ref)))
      throw new Error("Voice Studio current approved intent required");
    const selectedLedgers = selected.filter(
      (ref) => ref.content_schema?.schema_id === "penny.videogen-dependency-ledger.v1"
    );
    if (
      selectedLedgers.length !== 1 ||
      !selectedLedgers.some((ref) => sameRef(ref, r.selected_ledger_ref)) ||
      !selected.some((ref) => sameRef(ref, r.budget_reservation_ref))
    )
      throw new Error("Voice Studio current host-selected ledger/budget required");
    const ledger = validateDependencyLedger(
      this.read(
        r.selected_ledger_ref,
        DependencyLedgerV1Schema,
        "penny.videogen-dependency-ledger.v1"
      ),
      b.limits
    );
    if (
      ![r.script_ref, r.chunk_plan_ref, r.voice_ref, r.gate_decision_ref, r.asset_intent_ref].every(
        (ref) => ledger.nodes.some((n) => n.status === "current" && sameRef(n.ref, ref))
      )
    )
      throw new Error("Voice Studio current dependency ledger missing");
    const budget = validateBudgetReservation(
      this.read(
        r.budget_reservation_ref,
        BudgetReservationV1Schema,
        "penny.videogen-budget-reservation.v1"
      ),
      b.limits
    );
    if (
      budget.operation_kind !== "voice_job" ||
      budget.subject_id !== intent.asset_id ||
      !sameRef(budget.scope_gate_ref, r.gate_decision_ref) ||
      budget.state !== "held" ||
      Date.parse(rights.now_utc) < Date.parse(budget.created_at_utc) ||
      Date.parse(rights.now_utc) >= Date.parse(budget.expires_at_utc) ||
      d.attempt > intent.attempt_limit ||
      !sameRef(budget.policy_refs.queue, r.policy_refs.queue_policy_ref.ref) ||
      !sameRef(budget.policy_refs.inactivity, r.policy_refs.inactivity_policy_ref.ref) ||
      !sameRef(budget.policy_refs.cleanup, r.policy_refs.cleanup_policy_ref.ref)
    )
      throw new Error("Voice Studio finite held budget required");
    const prior = b.checkpointer.hostOperationCallsForRun(gate.run_id).filter((j) => {
      if (
        j.operation_kind !== "voice_job" ||
        (j.state_id === d.state_id && j.attempt === d.attempt && j.operation_id === d.operation_id)
      )
        return false;
      const previous = this.parseRequest(b.store.read(j.request_ref));
      return (
        sameRef(previous.asset_intent_ref, r.asset_intent_ref) &&
        sameRef(previous.gate_decision_ref, r.gate_decision_ref)
      );
    });
    if (prior.length + 1 > intent.attempt_limit)
      throw new Error("Voice Studio G1 attempt allowance exhausted");
    for (const m of budget.meters) {
      const authorized = intent.estimated_meters.find((x) => x.meter === m.meter);
      if (!authorized || m.reserved > authorized.reserved)
        throw new Error("Voice Studio budget exceeds G1");
    }
    if (
      !budget.meters.some((m) => m.meter === "attempts" && m.reserved - m.consumed >= 1) ||
      !budget.meters.some(
        (m) => m.meter === "stored_bytes" && m.reserved - m.consumed >= r.limits.max_output_bytes
      )
    )
      throw new Error("Voice Studio missing attempt/storage allowance");
    const policy = validateMediaPolicy(
      this.read(
        p.media_policy_ref,
        MediaDecodePolicyV1Schema,
        "penny.videogen-media-decode-policy.v1"
      )
    );
    return { script, plan, voice, policy };
  }
  readiness() {
    if (this.bindings.assurance === "trusted_local_api")
      throw new Error("API mode has no independent process readiness");
    const b = this.bindings,
      ref = b.observations.selected("readiness");
    const e = this.read(
        ref,
        VoiceStudioReadinessV1Schema,
        "penny.videogen-voice-studio-readiness.v1"
      ),
      now = Date.now();
    if (
      e.profile_sha256 !== b.profile_ref.content_digest ||
      !sameRef(e.service_build_ref, this.profile.service_build_ref) ||
      e.model_sha256 !== this.profile.model_sha256 ||
      e.process_worker_id !== this.profile.process_worker_id ||
      e.engine !== this.profile.engine ||
      e.isolation !== this.transport.mode ||
      e.observed_at_ms > now ||
      e.expires_at_ms <= now
    )
      throw new Error("Voice Studio readiness stale/build/transport mismatch");
    return e;
  }
  held(journal: HostOperationCallRecordV1): void {
    const b = this.bindings;
    b.capacity.requireHeld(journal);
    const record = this.capacityRecord(journal);
    if (!record) throw new Error("Voice Studio shared capacity absent");
    const binding = b.capacity_authority.binding(record.request.binding_id);
    if (
      binding.worker_id !== this.profile.process_worker_id ||
      binding.operation_kind !== "voice_job" ||
      binding.adapter_id !==
        (b.assurance === "trusted_local_api" ? VOICE_API_ADAPTER_ID : VOICE_STUDIO_ADAPTER_ID) ||
      binding.backend_binding_id !== this.profile.backend_binding_id ||
      !this.profile.gpu_resource_ids.every(
        (id) =>
          binding.resource_ids.includes(id) &&
          record.request.demands.some((d) => d.resource_id === id && d.slots > 0)
      )
    )
      throw new Error("Voice Studio physical GPU binding mismatch");
  }
  private capacityRecord(journal: HostOperationCallRecordV1) {
    const b = this.bindings,
      host = this.current();
    if (journal.project_id !== host.gate.project_id || journal.identity.run_id !== host.gate.run_id)
      throw new Error("Voice Studio capacity project/run mismatch");
    const record = b.capacity.check(journal);
    if (
      canonicalJson(record ?? null) !==
      canonicalJson(b.capacity_authority.inspect(journal.operation_record_id) ?? null)
    )
      throw new Error("Voice Studio capacity owners differ");
    return record;
  }
  /** Original trusted final readings, not reservation arithmetic or caller meter claims. */
  finalMeters(journal: HostOperationCallRecordV1) {
    const capacity = this.capacityRecord(journal);
    if (capacity?.state !== "settled" || capacity.snapshot?.kind !== "final")
      throw new Error("Voice Studio final trusted meter proof missing");
    const snapshot = capacity.snapshot;
    return Object.entries(METER_UNITS).map(([name, unit]) => {
      const meter = validateSkillSchema(MeterSchema, name, "meter");
      const amount = snapshot.readings.reduce((total, reading) => {
        const n = total + reading.meters[meter];
        if (!Number.isSafeInteger(n)) throw new Error("voice meter overflow");
        return n;
      }, 0);
      return { meter, unit, amount };
    });
  }
  coverage(
    correlation: VoiceStudioCorrelationV1,
    r: VoiceStudioJobRequestV1,
    narration: VoiceStudioNarrationV1
  ) {
    const ref = this.bindings.observations.selected("coverage", correlation);
    const e = this.read(
      ref,
      VoiceStudioCoverageV1Schema,
      "penny.videogen-voice-studio-coverage.v1"
    );
    const plan = this.read(
      r.chunk_plan_ref,
      VoiceStudioChunkPlanV1Schema,
      "penny.videogen-voice-studio-chunk-plan.v1"
    );
    if (
      canonicalJson(e.correlation) !== canonicalJson(correlation) ||
      !sameRef(e.script_ref, r.script_ref) ||
      !sameRef(e.chunk_plan_ref, r.chunk_plan_ref) ||
      e.voice_id !== r.voice_id ||
      e.narration_sha256 !== sha256(canonicalJson(narration)) ||
      e.observed_at_ms > Date.now() ||
      e.chunks.length !== plan.chunks.length ||
      new Set(e.chunks.map((x) => x.segment_id)).size !== e.chunks.length ||
      e.chunks.some(
        (x, i) =>
          x.chunk_id !== plan.chunks[i]?.chunk_id ||
          x.text_sha256 !== sha256(plan.chunks[i]?.text ?? "") ||
          x.voice_id !== r.voice_id ||
          x.resolved_voice_sha256 !== this.profile.voice_sha256
      )
    )
      throw new Error("Voice Studio partial/wrong-voice chunk coverage");
    return ref;
  }
}

Object.freeze(VoiceStudioAuthority.prototype);
Object.freeze(VoiceStudioAuthority);
