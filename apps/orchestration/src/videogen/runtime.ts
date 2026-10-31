import { AudioSourceV1Schema } from "./audio-sources.js";
import { VoiceStudioChunkPlanV1Schema } from "./voice-studio-contracts.js";
import { prepareSingleShotEdit } from "./runtime-single-shot.js";
import { VoiceApiProfileSchema } from "./voice-api-contracts.js";
import { materializeRuntimeVoice } from "./runtime-voice.js";
import {
  VoiceStudioJobRequestV1Schema,
  VoiceStudioProfileV1Schema,
} from "./voice-studio-contracts.js";
import { voiceStudioInputs } from "./voice-studio-authority.js";
import {
  validateChildWorkflowRequest,
  validateChildWorkflowResult,
  type ChildWorkflowCallRecord,
} from "../child-workflows/contracts.js";
import { PLAYBOOK_REGISTRY, validateGenericChildProviderRequest } from "../playbooks/registry.js";
import {
  IMAGEGEN_CHILD_OUTPUT,
  validateImagegenChildPolicy,
} from "../child-workflows/imagegen-policy.js";
import { validateImagegenRequest } from "../skill-contracts/imagegen.js";
import { childWorkflowCallId, childWorkflowRunIdentity } from "../child-workflows/contracts.js";
import { ImageAssetCallV1Schema } from "../imagegen/reference-contracts.js";
import { ImageAssetResultV1Schema } from "../imagegen/reference-contracts.js";
import { Type, type TSchema } from "typebox";
import {
  validateCapacityPolicy,
  hostCapacityWorkerKey,
  HostCapacityPolicyV1Schema,
} from "../host-operations/capacity-contracts.js";
import { materializeRuntimeMedia } from "./runtime-media.js";
import { bindRuntimeNativeRequest, materializeRuntimeNative } from "./runtime-native.js";
import { deriveFinalEdit } from "./runtime-final-edit.js";
import { effectPredecessor, RuntimeBudgetPolicyEvidenceSchema } from "./runtime-effect-bindings.js";
import { ArtifactStore } from "../artifact-store.js";
import { Checkpointer } from "../checkpointer.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  validateContract,
  validateDirective,
  type ArtifactRef,
  type Directive,
  type JsonValue,
} from "../contracts.js";
import type { RunContext } from "../context.js";
import { hostOperationPolicyBinding } from "../host-operations/contracts.js";
import {
  prepareHostEffectArtifacts,
  verifyHostResultWrapper,
} from "../host-operations/effect-protocol.js";
import {
  readVideogenStageProduct,
  videogenSemanticSchema,
  parseVideogenStageJson,
} from "./semantic-catalog.js";
import { validateVideogenStageSemantics } from "./stage-validation.js";
import {
  validateVideogenPrivateConfig,
  type VideogenRuntimeProvidersV1,
  type VideogenEffectRecipeV1,
} from "./runtime-config.js";
import {
  executionState,
  saveExecution,
  setSlot,
  slot,
  type VideogenExecutionStateV1,
} from "./execution-state.js";
import { bindScriptDraft, checkCanonScript } from "./admission.js";
import {
  validateVideoRequest,
  validateProjectEnvelope,
  AssetIntentV1Schema,
  ScriptV1Schema,
  LookVoiceSelectionV1Schema,
  LookVoiceTemplateV1Schema,
  BudgetReservationV1Schema,
  METER_UNITS,
  validateBudgetReservation,
} from "./foundation-contracts.js";
import {
  validateGatePacket,
  validateGateDecision,
  gateScopeDigest,
  type VideogenGateId,
} from "./gates.js";
import {
  initializeVideogenOwnerSelection,
  selectVideogenRights,
  VideogenOwnerSelection,
  readVideogenOwnerSelection,
} from "./owner-selection.js";
import {
  checkRights,
  RightsBindingV1Schema,
  ProvenanceBindingV1Schema,
  validateRightsBinding,
  CrossRunEdgeV1Schema,
  DependencyLedgerV1Schema,
  CurrentRightsV1Schema,
  type RightsBindingV1,
} from "./rights-ledger.js";
import {
  preflightVideogenStateInputs,
  videogenStatePorts,
  type VideogenExactInputV1,
} from "./state-ports.js";
import { VIDEOGEN_SUCCESSORS } from "./matrix.js";
import { validateVideogenWorker, workerState } from "./workers.js";
import {
  ShotMediaV1Schema,
  ShotResultV1Schema,
  NativeBuildResultV1Schema,
  PlaybackReviewV1Schema,
  VideogenTerminalV1Schema,
} from "./stage-contracts.js";
import { VideoEvidenceV1Schema } from "./media-contracts.js";
import { readExact, sameRef } from "./bounds.js";
import { NativeBuildRequestV1Schema } from "./native-contracts.js";
import {
  EditDecisionV1Schema,
  EditCaptionStyleV1Schema,
  PortableManifestV1Schema,
} from "./edit-contracts.js";
import { DeliveryIntentV1Schema, RawDeliveryResultV1Schema } from "./delivery.js";
const semantic = (name: string) => ({ schema_id: `penny.videogen-${name}.v1`, schema_version: 1 });
const gateIds: readonly VideogenGateId[] = ["G1", "G2", "G3", "G4", "G5"];
/** Fixed deterministic domain executor. It never invokes a model, HTTP client or application
 * process. Only returned registered child/host directives can leave this owner boundary. */
export class VideogenRuntime {
  readonly config;
  readonly binding_digest: string;
  constructor(
    readonly store: ArtifactStore,
    readonly checkpointer: Checkpointer,
    readonly project_id: string,
    readonly providers: VideogenRuntimeProvidersV1
  ) {
    store.assertBoundProject(project_id);
    checkpointer.assertBoundProject(project_id);
    this.config = validateVideogenPrivateConfig(providers.config);
    this.binding_digest = sha256(
      canonicalJson({
        project_id,
        config: this.config,
        recipes: providers.recipes,
        effects: [...providers.effects.values()].map((x) => ({
          declaration: x.declaration,
          request_schema: x.request_schema,
        })),
        information_child: providers.information_child ?? null,
        information_triggers: providers.information_triggers ?? [],
        imagegen_child: providers.imagegen_child ?? null,
        image_calls: [...(providers.image_calls ?? [])],
        image_requests: [...(providers.image_requests ?? [])].sort(([a], [b]) =>
          a.localeCompare(b)
        ),
      })
    );
  }
  assertConfig(c: RunContext): void {
    if (executionState(c).config_digest !== this.binding_digest)
      throw new Error("VIDEOGEN_PRIVATE_CONFIG_DRIFT: exact admitted private bindings changed");
  }
  read<T extends TSchema>(ref: ArtifactRef, schema: T) {
    const value = parseVideogenStageJson(
      readExact(this.store, this.project_id, ref, this.config.limits.max_json_bytes),
      schema,
      this.config.limits
    );
    const identity = validateContract(
      Type.Object({ schema_id: Type.String(), schema_version: Type.Integer() }),
      value,
      "selected product identity"
    );
    if (
      ref.media_type !== "application/json" ||
      identity.schema_id !== ref.content_schema?.schema_id ||
      identity.schema_version !== ref.content_schema.schema_version
    )
      throw new Error("videogen selected semantic ref/schema mismatch");
    return validateContract(schema, value, "videogen selected product");
  }
  seal(
    c: RunContext,
    name: string,
    value: unknown,
    upstream: readonly ArtifactRef[] = [],
    schema = videogenSemanticSchema(`penny.videogen-${name}.v1`),
    schemaId = `penny.videogen-${name}.v1`
  ): ArtifactRef {
    upstream = [...new Map(upstream.map((ref) => [canonicalJson(ref), ref])).values()];
    const content = canonicalJson(validateContract(schema, value, `videogen ${name}`));
    parseVideogenStageJson(Buffer.from(content), schema, this.config.limits);
    validateVideogenStageSemantics(`penny.videogen-${name}.v1`, value);
    const operation_id = `videogen:${sha256(canonicalJson({ state: c.stateId, name, content, upstream }))}`;
    const metadata = {
      schema_version: 2 as const,
      run_id: c.identity.run_id,
      phase: c.stateId,
      branch_id: null,
      kind: `videogen-${name}`,
      operation_id,
      version: 1,
      producer: "host:videogen",
      media_type: "application/json",
      content_schema: { schema_id: schemaId, schema_version: 1 },
      parent_ref: null,
      upstream_refs: [...upstream],
    };
    const prior = this.store.refFor(
      c.identity.run_id,
      c.stateId,
      null,
      metadata.kind,
      operation_id,
      1
    );
    const ref = prior ?? this.store.persist({ metadata, content });
    if (this.store.readById(ref.artifact_id).toString("utf8") !== content)
      throw new Error("videogen immutable seal conflict");
    if (!c.selectedArtifacts.some((x) => x.artifact_id === ref.artifact_id))
      c.selectedArtifacts.push(ref);
    return ref;
  }
  initialize(c: RunContext): void {
    const request = c.selectedArtifacts.find(
      (x) => x.content_schema?.schema_id === "penny.videogen-request.v1"
    );
    if (request === undefined) throw new Error("missing_input: videogen request");
    c.transition("admit");
    const q = this.seal(
      c,
      "envelope",
      validateProjectEnvelope(
        { ...this.config.envelope, request_ref: request },
        this.config.limits
      ),
      [request]
    );
    const l = this.seal(
      c,
      "dependency-ledger",
      {
        ...semantic("dependency-ledger"),
        nodes: [
          { stable_id: "request", role: "request", ref: request, revision: 1, status: "current" },
        ],
        edges: [],
        review_epochs: [],
        invalidations: [],
      },
      [request]
    );
    const s: VideogenExecutionStateV1 = {
      schema_version: 1,
      config_digest: this.binding_digest,
      slots: [
        { slot: "request", ref: request },
        { slot: "Q", ref: q },
        { slot: "L", ref: l },
        ...this.config.initial_products,
      ],
      shot_ids: [],
      shot_index: 0,
      asset_index: 0,
      effect_index: 0,
      effects: [],
    };
    saveExecution(c, s);
    for (const row of s.slots)
      if (!c.selectedArtifacts.some((x) => x.artifact_id === row.ref.artifact_id))
        c.selectedArtifacts.push(row.ref);
    initializeVideogenOwnerSelection(c, {
      project_id: this.project_id,
      limits: this.config.limits,
      admitted_destination_id: validateVideoRequest(
        this.read(request, videogenSemanticSchema("penny.videogen-request.v1")),
        this.config.limits
      ).destination_id,
      territory: this.config.territory,
    });
    selectVideogenRights(c, this.config.rights, this.config.cross_run_edge_refs);
    if (this.config.import_authorization_ref !== undefined) {
      const authorization = this.config.import_authorization_ref;
      const edges = this.config.rights
        .filter((row) => row.subject_ref.run_id !== c.identity.run_id)
        .map((row) => {
          const grant = this.read(row.rights_ref, RightsBindingV1Schema);
          return this.seal(
            c,
            "cross-run-edge",
            {
              ...semantic("cross-run-edge"),
              project_id: this.project_id,
              consumer_run_id: c.identity.run_id,
              source_ref: row.subject_ref,
              rights_ref: row.rights_ref,
              provenance_ref: grant.provenance_ref,
              authorization_ref: authorization,
            },
            [row.subject_ref, row.rights_ref, authorization],
            CrossRunEdgeV1Schema
          );
        });
      selectVideogenRights(c, this.config.rights, [...this.config.cross_run_edge_refs, ...edges]);
    }
    c.transition("brief_analysis");
  }
  bindings(c: RunContext): VideogenExactInputV1[] {
    const s = executionState(c),
      shot = s.shot_ids[s.shot_index];
    const aliases: Record<string, string> = {
      brief: "brief_analysis",
      options: c.stateId === "story_choice" ? "story_options" : "story_choice",
      outline: "story_plan",
      canon: "canon",
      assets: "assets",
      plan: "animatic_plan",
      look: c.stateId === "reference_verify" ? "look_check" : "look",
      rough: "rough_edit",
      edit: "final_edit",
      native_request: "native_request",
      graph: `graph-${shot}`,
      intent:
        c.stateId === "delivery_apply"
          ? "delivery_intent"
          : `intent-${this.config.assets[s.asset_index]?.asset_id}`,
      shot:
        c.stateId === "route_choice" || c.stateId === "shot_prepare" || c.stateId === "draft_apply"
          ? `route-${shot}`
          : c.stateId === "final_prepare"
            ? `draft-${shot}`
            : `media-${shot}`,
      evidence: c.stateId === "rough_review" ? "rough_video" : `video-${shot}`,
      audio: c.stateId === "rough_review" ? "rough_audio" : "master_audio",
      master: c.stateId === "g5" ? "master_review" : "master",
      video: "master_video",
      frames: "master_video",
      package: c.stateId === "g5" ? "package_review" : "manifest",
      native: "native",
      verified: `objective-${c.stateId.startsWith("reference") ? "reference" : c.stateId.startsWith("rough") ? "rough" : c.stateId.startsWith("master") ? "master" : shot}`,
      playback: "playback",
      terminal: "terminal",
      delivery: "delivery",
      route: "route_choice",
      information: `information-${c.stateId}`,
      synthesis: `synthesis-${c.stateId}`,
    };
    const rows: VideogenExactInputV1[] = [];
    for (const p of videogenStatePorts(
      c.stateId,
      c.stateId === "evidence_synthesis" ? s.synthesis_origin : undefined
    )) {
      if (p.max_items === null) {
        let refs: ArtifactRef[] = [];
        if (p.name === "conflicting_evidence") refs = s.synthesis_evidence ?? [];
        else if (p.name === "context") refs = this.config.brief_context_refs ?? [];
        else if (["asset_intents", "intents"].includes(p.name))
          refs = this.config.assets.map((a) => slot(s, `intent-${a.asset_id}`));
        else if (p.name === "png_evidence")
          refs = s.slots.filter((x) => x.slot.startsWith("png-")).map((x) => x.ref);
        else if (p.name === "audio" && c.stateId !== "finish_prepare")
          refs = s.slots.filter((x) => x.slot.startsWith("audio_evidence-")).map((x) => x.ref);
        else if (p.name === "drafts" || p.name === "finals")
          refs = s.shot_ids.map((id) =>
            slot(s, `${p.name === "drafts" ? "draft" : "final"}-${id}`)
          );
        else if (p.name === "voice" || p.name === "audio")
          refs = s.slots.filter((x) => x.slot.startsWith("audio_source-")).map((x) => x.ref);
        else if (p.name === "references" || p.name === "review")
          refs = s.slots
            .filter((x) =>
              x.slot.startsWith(p.name === "references" ? "reference_binding-" : "rough_binding-")
            )
            .map((x) => x.ref);
        else if (p.name === "source")
          refs = validateVideoRequest(
            this.read(slot(s, "request"), videogenSemanticSchema("penny.videogen-request.v1")),
            this.config.limits
          ).source_refs.map((x) => x.ref);
        refs.forEach((ref, i) => rows.push({ slot: `${p.name}-${i}`, ref }));
      } else {
        const name = aliases[p.name] ?? p.name;
        const ref = s.slots.find((x) => x.slot === name)?.ref;
        if (ref !== undefined) rows.push({ slot: p.name, ref });
        else if (p.min_items !== 0) throw new Error(`missing_input: ${c.stateId}.${name}`);
      }
    }
    preflightVideogenStateInputs({
      state: c.stateId,
      artifacts: this.store,
      project_id: this.project_id,
      limits: this.config.limits,
      max_input_bytes: this.config.envelope.max_source_bytes,
      bindings: rows,
      ...(c.stateId === "evidence_synthesis"
        ? { controls: { return_state: s.synthesis_origin } }
        : {}),
    });
    return rows;
  }
  acceptAuthored(c: RunContext): boolean {
    const original = this.config.authored_products?.find((row) => row.state === c.stateId);
    if (!original || !workerState(c.stateId)) return false;
    const product = this.read(
      original.ref,
      videogenSemanticSchema(
        c.stateId === "story_plan"
          ? "penny.videogen-story-outline.v1"
          : c.stateId === "script_text"
            ? "penny.videogen-script-draft.v1"
            : "penny.videogen-animatic-plan.v1"
      )
    );
    const validated = validateVideogenWorker(c.stateId, product);
    const ref = this.seal(c, validated.schema_id.slice("penny.videogen-".length, -3), validated, [
      original.ref,
      ...this.bindings(c).map((x) => x.ref),
    ]);
    const s = executionState(c);
    setSlot(c, s, c.stateId, ref);
    s.pending_worker_state = c.stateId;
    saveExecution(c, s);
    return true;
  }
  workerAccepted(c: RunContext, details: Record<string, JsonValue>): void {
    if (!workerState(c.stateId)) throw new Error("videogen non-worker result");
    const inputs = this.bindings(c);
    const result = validateVideogenWorker(c.stateId, details, new Set(inputs.map((x) => x.slot)));
    const raw = [...c.selectedArtifacts]
      .reverse()
      .find(
        (x) =>
          x.phase === c.stateId &&
          x.producer ===
            `agent:${c.pendingDirective?.action === "invoke_agent" ? c.pendingDirective.agent : ""}`
      );
    const ref = this.seal(c, result.schema_id.slice("penny.videogen-".length, -3), result, [
      ...inputs.map((x) => x.ref),
      ...(raw === undefined ? [] : [raw]),
    ]);
    const s = executionState(c);
    setSlot(c, s, c.stateId, ref);
    s.pending_worker_state = c.stateId;
    saveExecution(c, s);
  }
  next(c: RunContext, state: string): void {
    c.transition(state);
    const s = executionState(c);
    s.effect_index = 0;
    saveExecution(c, s);
  }
  afterWorker(c: RunContext): void {
    const s = executionState(c),
      state = s.pending_worker_state;
    if (state === undefined) return;
    delete s.pending_worker_state;
    saveExecution(c, s);
    const ref = slot(s, state);
    if (!workerState(state)) throw new Error("unknown worker");
    const value = validateVideogenWorker(
      state,
      this.read(ref, videogenSemanticSchema(ref.content_schema?.schema_id ?? ""))
    );
    const trigger = this.providers.information_triggers?.find((x) => x.trigger_state === state);
    const informationRecord =
      trigger === undefined
        ? undefined
        : this.checkpointer.childWorkflowCallForParent(
            c.identity.run_id,
            "child_call",
            this.informationCallKey(c, trigger)
          );
    if (
      trigger !== undefined &&
      (informationRecord?.lifecycle !== "consumed" ||
        !s.slots.some(
          (x) =>
            x.slot === `information-${state}` &&
            canonicalJson(x.ref) === canonicalJson(informationRecord.output_artifact)
        ))
    ) {
      if (this.providers.information_child === undefined)
        throw new Error("VIDEOGEN_INFORMATION_AUTHORITY_MISSING");
      s.information_origin = state;
      saveExecution(c, s);
      this.next(c, "child_call");
      return;
    }
    if (state === "evidence_synthesis") {
      const origin = s.synthesis_origin;
      if (origin === undefined || !("conflicts" in value))
        throw new Error("synthesis origin missing");
      if (value.unresolved.length > 0)
        throw new Error("VIDEOGEN_SYNTHESIS_UNRESOLVED: objective verifier remains blocked");
      setSlot(c, s, `synthesis-${origin}`, ref);
      delete s.synthesis_origin;
      delete s.synthesis_evidence;
      saveExecution(c, s);
      this.next(c, origin);
      return;
    }
    if ("contradiction_slots" in value && value.contradiction_slots !== undefined) {
      const inputs = this.bindings(c);
      const refs = value.contradiction_slots.map((name) => {
        const ref = inputs.find((x) => x.slot === name)?.ref;
        if (ref === undefined) throw new Error("contradiction names unavailable evidence");
        return ref;
      });
      if (new Set(refs.map((x) => x.artifact_id)).size < 2)
        throw new Error("contradiction requires distinct captured refs");
      const key = sha256(canonicalJson({ state, refs }));
      if (s.synthesis_keys?.includes(key))
        throw new Error("VIDEOGEN_CONTRADICTION_UNRESOLVED: repeated verifier conflict");
      s.synthesis_keys = [...(s.synthesis_keys ?? []), key];
      s.synthesis_origin = state;
      s.synthesis_evidence = refs;
      saveExecution(c, s);
      this.next(c, "evidence_synthesis");
      return;
    }
    if (value.needs_clarification === true) {
      s.return_state = state;
      saveExecution(c, s);
      this.next(c, "clarify");
      return;
    }
    if (state === "story_plan") {
      const outline = this.read(ref, videogenSemanticSchema("penny.videogen-story-outline.v1"));
      const parsed = validateVideogenWorker("story_plan", outline);
      if (!("shots" in parsed)) throw new Error("outline required");
      s.shot_ids = parsed.shots.map((x) => x.shot_id);
      s.shot_index = 0;
      saveExecution(c, s);
      if (s.shot_ids.length > this.config.envelope.max_shots)
        throw new Error("shot admission limit");
      for (const route of this.config.routes) {
        const r = this.seal(c, "shot-route", route);
        setSlot(c, s, `route-${route.shot_id}`, r);
      }
    }
    if (state === "script_text")
      setSlot(
        c,
        s,
        "script",
        this.seal(
          c,
          "script",
          bindScriptDraft({
            store: this.store,
            project_id: this.project_id,
            outline_ref: slot(s, "story_plan"),
            draft_ref: ref,
            limits: this.config.limits,
          }),
          [ref, slot(s, "story_plan")]
        )
      );
    if (state === "script_text" && this.config.script_rights_source_slots !== undefined)
      setSlot(
        c,
        s,
        "script_rights",
        this.inheritRights(
          c,
          slot(s, "script"),
          this.config.script_rights_source_slots.map((name) => slot(s, name)),
          ref,
          "text"
        )
      );
    if (state === "story_check") {
      const outline = validateVideogenWorker(
        "story_plan",
        this.read(slot(s, "story_plan"), videogenSemanticSchema("penny.videogen-story-outline.v1"))
      );
      if (!("shots" in outline)) throw new Error("outline required");
      const canon = checkCanonScript(
        {
          ...semantic("story-canon"),
          brief_ref: slot(s, "request"),
          story_version: ref.version,
          audience: "As specified in admitted brief",
          emotion: "As specified in admitted brief",
          style_intent: "As specified in admitted brief",
          fixed_choices: [],
          delegated_choices: [],
          script_ref: slot(s, "script"),
          scenes: outline.scenes,
          shots: outline.shots,
          acceptance_criteria: outline.acceptance_criteria,
          unresolved: [],
        },
        this.read(slot(s, "script"), ScriptV1Schema),
        slot(s, "script"),
        this.config.limits
      );
      setSlot(
        c,
        s,
        "canon",
        this.seal(c, "story-canon", canon, [ref, slot(s, "script"), slot(s, "story_plan")])
      );
      this.proposeAssets(c);
    }
    if (state.endsWith("verify") || state.endsWith("critique") || state === "rough_review")
      this.bindReview(c, state, ref);
    if (state === "reference_critique") this.look(c);
    if (state === "draft_critique" || state === "final_critique") {
      const shot = s.shot_ids[s.shot_index];
      if (shot === undefined) throw new Error("selected shot missing");
      const media = this.read(slot(s, `media-${shot}`), ShotMediaV1Schema);
      const result = this.seal(
        c,
        "shot-result",
        {
          ...(({ audio_policy, ...fields }) => {
            void audio_policy;
            return fields;
          })(media),
          ...semantic("shot-result"),
          shot_media_ref: slot(s, `media-${shot}`),
          objective_binding_ref: slot(s, `objective-${shot}`),
          quality_binding_ref: slot(s, `quality-${shot}`),
          disposition: "accepted",
        },
        [ref, slot(s, `media-${shot}`)]
      );
      this.inheritRights(c, result, [media.clip_ref], ref, "video");
      setSlot(c, s, `${state === "draft_critique" ? "draft" : "final"}-${shot}`, result);
      s.shot_index++;
      saveExecution(c, s);
      if (s.shot_index < s.shot_ids.length) {
        this.next(c, state === "draft_critique" ? "shot_prepare" : "final_prepare");
        return;
      }
      s.shot_index = 0;
      saveExecution(c, s);
    }
    if (state === "master_critique") {
      this.masterReviews(c);
      if (c.stateId === "clarify") return;
    }
    const successor =
      state === "brief_analysis"
        ? this.config.optional.research
          ? "research_fact"
          : this.config.optional.alternatives
            ? "story_options"
            : "story_plan"
        : state === "research_fact"
          ? this.config.optional.alternatives
            ? "story_options"
            : "story_plan"
          : state === "draft_critique"
            ? "rough_build"
            : state === "final_critique"
              ? "finish_prepare"
              : VIDEOGEN_SUCCESSORS[state]?.[0];
    if (successor === undefined) throw new Error(`no videogen successor ${state}`);
    this.next(c, successor);
  }
  /** Preserve the intersection of existing current grants and exact producer lineage. This
   * cannot add a use, territory, consent, license or lifetime absent from a cleared ancestor. */
  inheritRights(
    c: RunContext,
    subject: ArtifactRef,
    sources: readonly ArtifactRef[],
    producerReceipt: ArtifactRef,
    kind: RightsBindingV1["subject_kind"]
  ): ArtifactRef {
    if (sources.length === 0) throw new Error("VIDEOGEN_RIGHTS_ANCESTOR_REQUIRED");
    const selection = validateContract(
      Type.Object({
        rights: Type.Array(CurrentRightsV1Schema),
        cross_run_edge_refs: Type.Array(ArtifactRefSchema),
      }),
      c.playbookData.videogen_owner_selection,
      "prepared derivation rights"
    );
    const current = {
      store: this.store,
      project_id: this.project_id,
      run_id: c.identity.run_id,
      limits: this.config.limits,
      territory: this.config.territory,
      now_utc: new Date().toISOString(),
      current_rights: selection.rights,
      cross_run_edges: selection.cross_run_edge_refs.map((ref) =>
        this.read(ref, CrossRunEdgeV1Schema)
      ),
    };
    const unique = [...new Map(sources.map((r) => [r.artifact_id, r])).values()];
    const grants = unique.map((source) => {
      const row = current.current_rights.find((r) => sameRef(r.subject_ref, source));
      if (row === undefined) throw new Error("VIDEOGEN_CURRENT_DERIVATION_RIGHTS_REQUIRED");
      return checkRights(current, source, row.rights_ref, "preview");
    });
    const first = grants[0];
    if (first === undefined || grants.some((r) => !sameRef(r.license_ref, first.license_ref)))
      throw new Error("VIDEOGEN_COMBINED_LICENSE_DERIVATION_UNSUPPORTED");
    const provenance = this.seal(
      c,
      "provenance-binding",
      {
        ...semantic("provenance-binding"),
        subject_ref: subject,
        source_refs: unique,
        producer_receipt_ref: producerReceipt,
      },
      [subject, producerReceipt, ...unique],
      ProvenanceBindingV1Schema
    );
    const value = validateRightsBinding(
      {
        ...semantic("rights-binding"),
        subject_ref: subject,
        subject_kind: kind,
        revision: subject.version,
        provenance_ref: provenance,
        license_ref: first.license_ref,
        derived_from_rights_refs: unique.map((source) => {
          const row = current.current_rights.find((r) => sameRef(r.subject_ref, source));
          if (row === undefined) throw new Error("ancestor rights missing");
          return row.rights_ref;
        }),
        consent_refs: [
          ...new Map(grants.flatMap((r) => r.consent_refs).map((r) => [r.artifact_id, r])).values(),
        ],
        allowed_uses: first.allowed_uses.filter((use) =>
          grants.every((r) => r.allowed_uses.includes(use))
        ),
        territories: first.territories.filter((territory) =>
          grants.every((r) => r.territories.includes(territory))
        ),
        credits: [...new Set(grants.flatMap((r) => r.credits))],
        valid_from_utc: grants
          .map((r) => r.valid_from_utc)
          .sort((a, b) => Date.parse(b) - Date.parse(a))[0],
        expires_at_utc: grants
          .map((r) => r.expires_at_utc)
          .sort((a, b) => Date.parse(a) - Date.parse(b))[0],
      },
      this.config.limits
    );
    const rights = this.seal(
      c,
      "rights-binding",
      value,
      [provenance, ...grants.map((g) => g.license_ref)],
      RightsBindingV1Schema
    );
    const edges = current.cross_run_edges.map((edge) =>
      this.seal(c, "cross-run-edge", edge, [], CrossRunEdgeV1Schema)
    );
    if (subject.run_id !== c.identity.run_id)
      edges.push(
        this.seal(
          c,
          "cross-run-edge",
          {
            ...semantic("cross-run-edge"),
            project_id: this.project_id,
            consumer_run_id: c.identity.run_id,
            source_ref: subject,
            rights_ref: rights,
            provenance_ref: provenance,
            authorization_ref: producerReceipt,
          },
          [subject, rights, producerReceipt],
          CrossRunEdgeV1Schema
        )
      );
    selectVideogenRights(
      c,
      [
        ...current.current_rights.filter((r) => !sameRef(r.subject_ref, subject)),
        { subject_ref: subject, rights_ref: rights, revision: subject.version, status: "cleared" },
      ],
      edges
    );
    return rights;
  }
  proposeAssets(c: RunContext): void {
    const s = executionState(c);
    // A newly sealed story is a derivative of existing cleared inputs, never a new grant.
    const fresh = this.config.assets.filter((a) => a.source === "imagegen_fresh");
    if (fresh.length > 0) {
      const current = readVideogenOwnerSelection(
        new VideogenOwnerSelection({
          store: this.store,
          checkpointer: this.checkpointer,
          project_id: this.project_id,
          run_id: c.identity.run_id,
        })
      ).rights;
      const sources = fresh.map((asset) => {
        const row = current.current_rights.find(
          (r) => sameRef(r.rights_ref, asset.rights_ref) && r.status === "cleared"
        );
        if (row === undefined) throw new Error("VIDEOGEN_FRESH_STORY_CURRENT_RIGHTS_REQUIRED");
        const binding = checkRights(current, row.subject_ref, row.rights_ref, "preview");
        if (!binding.consent_refs.some((r) => sameRef(r, asset.consent_ref)))
          throw new Error("VIDEOGEN_FRESH_STORY_CONSENT_REQUIRED");
        return row.subject_ref;
      });
      const rights = this.inheritRights(
        c,
        slot(s, "canon"),
        sources,
        slot(s, "story_check"),
        "text"
      );
      setSlot(c, s, "story_rights", rights);
    }
    for (const asset of this.config.assets) {
      let input_refs = asset.input_refs;
      if (asset.source === "voice_studio") {
        const scriptRef = slot(s, "script"),
          script = this.read(scriptRef, ScriptV1Schema),
          lines = [
            ...script.scenes.flatMap((scene) => scene.ordered_lines),
            ...script.narration_lines,
          ];
        const plan = this.seal(
          c,
          "voice-studio-chunk-plan",
          {
            schema_id: "penny.videogen-voice-studio-chunk-plan.v1",
            schema_version: 1,
            script_ref: scriptRef,
            source_text: lines.map((line) => line.text).join("\n"),
            chunks: lines.map((line, i) => ({
              chunk_id: `line_${i + 1}`,
              line_ids: [line.line_id],
              text: line.text,
            })),
          },
          [scriptRef],
          VoiceStudioChunkPlanV1Schema
        );
        setSlot(c, s, `chunk_plan-${asset.asset_id}`, plan);
        input_refs = [...input_refs, scriptRef, plan];
      }
      setSlot(
        c,
        s,
        `intent-${asset.asset_id}`,
        this.seal(
          c,
          "asset-intent",
          {
            ...semantic("asset-intent"),
            ...asset,
            input_refs,
            ...(asset.source === "imagegen_fresh" ? { rights_ref: slot(s, "story_rights") } : {}),
            story_ref: slot(s, "canon"),
            scope_status: "proposed",
          },
          [slot(s, "canon")]
        )
      );
    }
    for (const asset of this.config.assets)
      setSlot(c, s, `proposal-${asset.asset_id}`, slot(s, `intent-${asset.asset_id}`));
  }
  imageAsset(c: RunContext, assetId: string) {
    const s = executionState(c),
      intent_ref = slot(s, `proposal-${assetId}`),
      template = this.providers.image_requests?.get(assetId);
    if (template === undefined) throw new Error("VIDEOGEN_IMAGE_REQUEST_MISSING");
    return {
      schema_id: "penny.image-asset-request.v1" as const,
      schema_version: 1 as const,
      intent_ref,
      call_index: 1,
      input: template.asset?.input ?? { kind: "fresh" as const },
    };
  }
  imageCallKey(c: RunContext, assetId: string): string {
    return `image-${assetId}-${this.imageAsset(c, assetId).intent_ref.content_digest.slice(0, 24)}`;
  }
  imageCallProducts(c: RunContext): ArtifactRef[] {
    const refs: ArtifactRef[] = [];
    for (const [assetId, policy] of this.providers.image_calls ?? []) {
      const asset = this.imageAsset(c, assetId),
        template = this.providers.image_requests?.get(assetId);
      if (template === undefined) throw new Error("image call template missing");
      const callId = childWorkflowCallId({
        parent_run_id: c.identity.run_id,
        parent_state_id: "image_child",
        call_key: this.imageCallKey(c, assetId),
      });
      const child = childWorkflowRunIdentity({
        call_id: callId,
        parent: c.identity,
        child_name: "imagegen",
      });
      const value = validateContract(
        ImageAssetCallV1Schema,
        {
          schema_id: "penny.image-asset-call.v1",
          schema_version: 1,
          asset,
          image_run_id: child.run_id,
          profile_sha256: policy.profile_sha256,
          max_renders: 1 + template.max_revision_rounds,
          cost_microcredits: policy.cost_microcredits,
        },
        "image G1 call plan"
      );
      const content = canonicalJson(value),
        operation_id = `image-call:${sha256(content)}`;
      const ref =
        this.store.refFor(
          c.identity.run_id,
          c.stateId,
          null,
          "image-asset-call",
          operation_id,
          1
        ) ??
        this.store.persist({
          metadata: {
            schema_version: 2,
            run_id: c.identity.run_id,
            phase: c.stateId,
            branch_id: null,
            kind: "image-asset-call",
            operation_id,
            version: 1,
            producer: "host:videogen",
            media_type: "application/json",
            content_schema: { schema_id: value.schema_id, schema_version: 1 },
            parent_ref: null,
            upstream_refs: [asset.intent_ref],
          },
          content,
        });
      if (this.store.read(ref).toString() !== content) throw new Error("image call plan conflict");
      setSlot(c, executionState(c), `image-call-${assetId}`, ref);
      refs.push(ref);
    }
    return refs;
  }
  bindReview(c: RunContext, state: string, ref: ArtifactRef): void {
    const s = executionState(c);
    if (!workerState(state)) throw new Error("review worker missing");
    const review = validateVideogenWorker(
      state,
      this.read(ref, videogenSemanticSchema(ref.content_schema?.schema_id ?? ""))
    );
    if (!("target_slot" in review) || review.disposition !== "pass")
      throw new Error("review must pass before binding");
    const inputs = this.bindings(c),
      target = inputs.find((x) => x.slot === review.target_slot)?.ref;
    if (target === undefined) throw new Error("review invented target");
    const evidence = inputs.filter((x) => x.slot !== review.target_slot).map((x) => x.ref);
    const binding = this.seal(
      c,
      "review-binding",
      {
        ...semantic("review-binding"),
        worker_result_ref: ref,
        target_ref: target,
        evidence_refs: evidence,
        model_capability_ref: this.config.model_capability_ref,
        disposition: review.disposition,
      },
      [ref, ...inputs.map((x) => x.ref)]
    );
    const id = state.startsWith("reference")
      ? "reference"
      : state.startsWith("rough")
        ? "rough"
        : state.startsWith("master")
          ? "master"
          : s.shot_ids[s.shot_index];
    const kind = state.endsWith("critique") ? "quality" : "objective";
    setSlot(c, s, `${kind}-${id}`, binding);
    if (id === "reference" || id === "rough") setSlot(c, s, `${id}_binding-${kind}`, binding);
  }
  look(c: RunContext): void {
    const s = executionState(c);
    const existing = slot(s, "look_template");
    const template = this.read(
      existing,
      Type.Union([LookVoiceSelectionV1Schema, LookVoiceTemplateV1Schema])
    );
    setSlot(
      c,
      s,
      "look",
      this.seal(
        c,
        "look-voice",
        {
          ...template,
          ...semantic("look-voice"),
          story_ref: slot(s, "canon"),
          ...(() => {
            const voice =
              this.config.assets.find((a) => a.source === "voice_studio") ??
              this.config.assets.find(
                (a) =>
                  a.asset_id === template.voice_identity.voice_id &&
                  ["voice_preview", "performance"].includes(a.purpose)
              );
            if (!voice) return {};
            const audio = this.read(slot(s, `audio_source-${voice.asset_id}`), AudioSourceV1Schema);
            return {
              performance_ref: audio.media_ref,
              audio_evidence_ref: slot(s, `audio_evidence-${voice.asset_id}`),
              timing_ref: slot(s, `audio_measurement-${voice.asset_id}`),
            };
          })(),
          approved_pngs: this.config.assets
            .filter(
              (a) =>
                a.source !== "voice_studio" && s.slots.some((x) => x.slot === `png-${a.asset_id}`)
            )
            .map((a) => ({
              asset_id: a.asset_id,
              role: a.purpose,
              revision: slot(s, `png-${a.asset_id}`).version,
              png_ref: slot(s, `png-${a.asset_id}`),
            })),
          preview_receipts: s.effects.map((x) => x.wrapper_ref),
        },
        [slot(s, "canon"), existing],
        LookVoiceSelectionV1Schema
      )
    );
  }
  capturePlayback(c: RunContext, ref: ArtifactRef): void {
    this.assertConfig(c);
    const s = executionState(c);
    if (c.stateId !== "clarify" || s.return_state !== "master_critique")
      throw new Error("videogen is not awaiting independent playback");
    const review = this.read(ref, PlaybackReviewV1Schema),
      master = slot(s, "master");
    if (
      canonicalJson(review.target_ref) !== canonicalJson(master) ||
      review.target_digest !== master.content_digest ||
      review.reviewer_kind !== "human" ||
      !review.complete_viewing ||
      !review.heard_audio
    )
      throw new Error("playback does not attest current complete human AV viewing");
    setSlot(c, s, "playback", ref);
  }
  masterReviews(c: RunContext): void {
    const s = executionState(c),
      playback = s.slots.find((x) => x.slot === "playback")?.ref;
    if (playback === undefined) {
      s.return_state = "master_critique";
      saveExecution(c, s);
      this.next(c, "clarify");
      return;
    }
    const p = this.read(playback, PlaybackReviewV1Schema);
    if (
      p.target_digest !== slot(s, "master").content_digest ||
      !p.complete_viewing ||
      !p.heard_audio ||
      [p.motion_verdict, p.speech_verdict, p.sync_verdict, p.identity_verdict].some(
        (x) => x !== "pass"
      )
    )
      throw new Error("independent exact-master playback is incomplete");
    const native = this.read(slot(s, "native"), NativeBuildResultV1Schema);
    if (native.status !== "qualified") throw new Error("native production adapter is unqualified");
    setSlot(
      c,
      s,
      "master_review",
      this.seal(c, "master-review", {
        ...semantic("master-review"),
        master_ref: slot(s, "master"),
        decode_ref: slot(s, "master_video"),
        audio_evidence_ref: slot(s, "master_audio"),
        playback_review_ref: playback,
        used_shot_results: s.shot_ids.map((id) => slot(s, `final-${id}`)),
        caption_check_ref: slot(s, "objective-master"),
        sync_check_ref: playback,
        postprocess_evidence_refs: [],
        disposition: "accepted",
      })
    );
    setSlot(
      c,
      s,
      "package_review",
      this.seal(c, "package-review", {
        ...semantic("package-review"),
        manifest_ref: slot(s, "manifest"),
        project_ref: native.normalized_project_ref,
        feature_subset_ref: slot(s, "feature_subset"),
        open_save_ref: native.open_save_receipt_ref,
        reopen_ref: native.reopen_receipt_ref,
        relocation_ref: native.relocation_receipt_ref,
        render_comparison_ref: native.render_comparison_ref,
        rights_closure_ref: slot(s, "rights_closure"),
        source_closure_ref: slot(s, "source_closure"),
        disposition: "accepted",
      })
    );
  }
  refreshLedger(c: RunContext): void {
    const s = executionState(c);
    const current = validateContract(
      Type.Object({ rights: Type.Array(CurrentRightsV1Schema) }),
      c.playbookData.videogen_owner_selection,
      "prepared current grants"
    ).rights;
    const entries = [
      ...new Map(
        s.slots
          .filter(
            (x) =>
              x.slot !== "Q" &&
              x.slot !== "L" &&
              x.slot !== "packet" &&
              (x.ref.run_id === c.identity.run_id ||
                current.some((r) => sameRef(r.subject_ref, x.ref)))
          )
          .map((x) => [x.ref.artifact_id, x])
      ).values(),
    ];
    const role = (name: string, ref: ArtifactRef) =>
      ref.media_type.startsWith("image/")
        ? "reference"
        : ref.media_type.startsWith("audio/")
          ? "voice"
          : ref.media_type.startsWith("video/")
            ? name === "master"
              ? "master"
              : "reference"
            : name === "request"
              ? "request"
              : name === "canon" || name === "story_plan"
                ? "story"
                : name === "script"
                  ? "script"
                  : name === "look"
                    ? "review" // Selection metadata; referenced media retain their own rights nodes.
                    : name === "performance"
                      ? "performance"
                      : name.startsWith("draft-")
                        ? "draft"
                        : name.startsWith("final-")
                          ? "final"
                          : name === "master"
                            ? "master"
                            : name === "manifest"
                              ? "package"
                              : name.includes("edit")
                                ? "edit"
                                : gateIds.some((g) => g === name)
                                  ? "approval"
                                  : "effect";
    const selectedRights = validateContract(
      Type.Object({ rights: Type.Array(CurrentRightsV1Schema) }),
      c.playbookData.videogen_owner_selection,
      "prepared rights selection"
    ).rights;
    const nodes = entries.map((entry) => ({
      stable_id: entry.slot,
      role: role(entry.slot, entry.ref),
      ref: entry.ref,
      revision: entry.ref.version,
      status: "current",
      ...(selectedRights.find((x) => x.subject_ref.artifact_id === entry.ref.artifact_id) ===
      undefined
        ? {}
        : {
            rights_ref: selectedRights.find(
              (x) => x.subject_ref.artifact_id === entry.ref.artifact_id
            )?.rights_ref,
          }),
    }));
    const edges: { from: string; to: string; reason: "source" }[] = [];
    const findRefs = (value: unknown, out: Set<string>): void => {
      if (value === null || typeof value !== "object") return;
      if ("artifact_id" in value && typeof value.artifact_id === "string") {
        out.add(value.artifact_id);
        return;
      }
      for (const item of Object.values(value)) findRefs(item, out);
    };
    for (const entry of entries)
      if (
        entry.ref.content_schema?.schema_id.startsWith("penny.videogen-") &&
        entry.ref.media_type === "application/json" &&
        entry.ref.byte_length <= this.config.limits.max_json_bytes
      ) {
        const refs = new Set<string>();
        findRefs(
          JSON.parse(
            readExact(
              this.store,
              this.project_id,
              entry.ref,
              this.config.limits.max_json_bytes
            ).toString("utf8")
          ),
          refs
        );
        for (const prior of entries)
          if (prior.slot !== entry.slot && refs.has(prior.ref.artifact_id))
            edges.push({ from: prior.slot, to: entry.slot, reason: "source" });
      }
    setSlot(
      c,
      s,
      "L",
      this.seal(c, "dependency-ledger", {
        ...semantic("dependency-ledger"),
        nodes,
        edges,
        review_epochs: [],
        invalidations: [],
      })
    );
  }
  gate(c: RunContext, id: VideogenGateId | "clarify"): Directive {
    const imageCalls = id === "G1" ? this.imageCallProducts(c) : [];
    this.refreshLedger(c);
    const s = executionState(c),
      input =
        id === "clarify"
          ? [{ slot: "target", ref: slot(s, s.return_state ?? "request") }]
          : this.bindings(c);
    const presented = [
      ...new Map(
        input
          .filter((x) => x.slot !== "Q" && x.slot !== "L" && !gateIds.some((g) => g === x.slot))
          .map((x) => [
            x.ref.artifact_id,
            {
              role:
                x.slot === "canon"
                  ? "story"
                  : x.slot.startsWith("asset_intents-")
                    ? "asset-intent"
                    : id === "G2" && x.slot === "look"
                      ? "look-voice"
                      : id === "G4" && x.slot === "rough"
                        ? "rough-cut"
                        : x.slot,
              ref: x.ref,
              revision: x.ref.version,
            },
          ])
      ).values(),
    ];
    for (const ref of imageCalls)
      presented.push({ role: "image-asset-call", ref, revision: ref.version });
    if (id === "G5") {
      for (const item of presented) {
        if (item.role === "master") item.role = "master-review";
        if (item.role === "package") item.role = "package-review";
      }
      const native = this.read(slot(s, "native"), NativeBuildResultV1Schema);
      for (const [role, ref] of [
        ["master", slot(s, "master")],
        ["package", slot(s, "manifest")],
        ["project", native.normalized_project_ref],
      ] as const)
        presented.push({ role, ref, revision: ref.version });
    }
    const scope =
      id === "G1"
        ? {
            kinds: [
              "voice_job",
              "child_imagegen",
              ...(this.config.assets.some(
                (a) =>
                  a.source === "supplied" &&
                  (a.purpose === "performance" || a.purpose === "voice_preview")
              ) ||
              this.providers.recipes.some(
                (recipe) =>
                  recipe.stage === "asset" &&
                  recipe.kind === "media_decode_extract" &&
                  this.config.assets.some(
                    (asset) =>
                      asset.asset_id === recipe.subject_id &&
                      asset.source === "voice_studio" &&
                      (asset.purpose === "performance" || asset.purpose === "voice_preview")
                  )
              )
                ? ["media_decode_extract"]
                : []),
            ],
            subject_ids: this.config.assets.map((x) => x.asset_id),
            meters: [
              ...new Set([
                "attempts",
                ...this.config.assets.flatMap((a) => a.estimated_meters.map((m) => m.meter)),
              ]),
            ].map((meter) => {
              const total = this.config.assets
                .flatMap((a) => a.estimated_meters)
                .filter((m) => m.meter === meter)
                .reduce((n, m) => n + BigInt(m.reserved), 0n);
              const cap =
                meter === "attempts"
                  ? this.config.envelope.max_attempts
                  : meter === "cost_microcredits"
                    ? this.config.envelope.max_cost_units -
                      this.config.envelope.finish_reserve_cost_units
                    : meter === "stored_bytes"
                      ? this.config.envelope.max_storage_bytes -
                        this.config.envelope.finish_reserve_bytes
                      : this.config.limits.max_integer;
              if (total > BigInt(cap))
                throw new Error("VIDEOGEN_PREVIEW_SCOPE_EXCEEDS_ADMITTED_ENVELOPE");
              return { meter, limit: meter === "attempts" ? cap : Number(total) };
            }),
          }
        : id === "G3" || id === "G4"
          ? {
              kinds: [
                "reference_upload",
                "video_render",
                "media_decode_extract",
                "timeline_master",
                ...(id === "G4" ? ["kdenlive_build_verify"] : []),
              ],
              subject_ids: s.shot_ids,
              meters: [{ meter: "attempts", limit: this.config.envelope.max_attempts }],
            }
          : {
              kinds: [],
              subject_ids: [],
              meters: [],
              ...(id === "G5"
                ? {
                    destination_id: validateVideoRequest(
                      this.read(
                        slot(s, "request"),
                        videogenSemanticSchema("penny.videogen-request.v1")
                      ),
                      this.config.limits
                    ).destination_id,
                  }
                : {}),
            };
    if (id === "G3" || id === "G4") {
      const campaign = this.providers.recipes.filter((r) =>
        id === "G3"
          ? r.stage === "draft" || r.stage === "rough"
          : r.stage === "final" || r.stage === "finished"
      );
      scope.subject_ids = [...new Set([...s.shot_ids, ...campaign.map((r) => r.subject_id)])];
      const meters = campaign.flatMap((r) => r.budget_policy?.meters ?? []);
      if (meters.length > 0)
        scope.meters = [...new Set(meters.map((m) => m.meter))].map((meter) => {
          const total = meters
            .filter((m) => m.meter === meter)
            .reduce((n, m) => n + BigInt(m.reserved), 0n);
          if (total > BigInt(this.config.limits.max_integer))
            throw new Error("VIDEOGEN_SCOPE_METER_OVERFLOW");
          return { meter, limit: Number(total) };
        });
    }
    const challenge = `vg_${sha256(canonicalJson({ run: c.identity.run_id, state: c.stateId, step: c.stepCount, presented }))}`;
    const packet = validateGatePacket(
      {
        ...semantic("gate-packet"),
        kind: id === "clarify" ? "clarification" : "approval",
        gate_id: id,
        run_id: c.identity.run_id,
        challenge,
        producer_state:
          id === "G1"
            ? "story_plan"
            : id === "G2"
              ? "asset_prepare"
              : id === "G3"
                ? "animatic_plan"
                : id === "G4"
                  ? "rough_build"
                  : "finish_prepare",
        presented,
        prior_decisions: gateIds.flatMap((g) =>
          s.slots.filter((x) => x.slot === g).map((x) => x.ref)
        ),
        change_summary:
          c.clarificationText || "Review the exact selected versions and bounded scope.",
        affected_shot_ids: s.shot_ids,
        limitations: [
          "Still-frame reviews do not establish motion, sound, speech or synchronization.",
        ],
        rights_refs: validateContract(
          Type.Object({ rights: Type.Array(CurrentRightsV1Schema) }),
          c.playbookData.videogen_owner_selection,
          "prepared rights selection"
        ).rights.map((x) => x.rights_ref),
        review_evidence_refs: [],
        questions: [
          id === "clarify"
            ? "Provide the missing exact evidence; an answer grants no effect permission."
            : `Approve, refine or deny ${id}.`,
        ],
        choices: id === "clarify" ? ["answer", "cancel"] : ["approve", "refine", "deny"],
        ...(id === "clarify" ? {} : { effect_scope: scope }),
      },
      this.config.limits
    );
    const ref = this.seal(
      c,
      "gate-packet",
      packet,
      input.map((x) => x.ref)
    );
    setSlot(c, s, "packet", ref);
    const directive = validateDirective({
      schema_version: 2,
      action: "await_user",
      identity: c.identity,
      state_id: c.stateId,
      gate_id: `videogen-${id}-${c.stepCount}`,
      challenge,
      payload_digest: ref.content_digest,
      questions: [
        {
          id: "decision",
          prompt: `${id}: respond with a closed GateDecisionV1 for ${ref.artifact_id}.`,
        },
      ],
    });
    c.pendingDirective = directive;
    c.status = "awaiting_user";
    return directive;
  }
  resume(c: RunContext, response: JsonValue): void {
    const s = executionState(c),
      decision = validateGateDecision(response, this.config.limits),
      packetRef = slot(s, "packet"),
      packet = this.read(packetRef, videogenSemanticSchema("penny.videogen-gate-packet.v1"));
    if (
      decision.run_id !== c.identity.run_id ||
      canonicalJson(decision.packet_ref) !== canonicalJson(packetRef)
    )
      throw new Error("gate response binding mismatch");
    const p = validateGatePacket(packet, this.config.limits);
    if (
      decision.challenge !== p.challenge ||
      decision.gate_id !== p.gate_id ||
      (decision.choice === "approve" &&
        decision.resulting_scope_digest !== gateScopeDigest(p, packetRef))
    )
      throw new Error("gate response scope mismatch");
    const ref = this.seal(c, "gate-decision", decision, [packetRef]);
    setSlot(c, s, decision.gate_id, ref);
    c.status = "running";
    if (decision.choice === "deny" || decision.choice === "cancel") {
      this.next(c, decision.choice === "deny" ? "incomplete" : "cancelled");
      return;
    }
    if (decision.choice === "refine") {
      c.clarificationText = decision.refinement_text ?? "Refine presented version";
      const targets: Record<string, string> = {
        G1: "story_plan",
        G2: "asset_prepare",
        G3: "animatic_plan",
        G4: "rough_build",
        G5: "finish_prepare",
      };
      this.invalidate(c, targets[decision.gate_id] ?? "admit");
      return;
    }
    if (decision.choice === "answer") {
      c.clarificationText = decision.refinement_text ?? "";
      this.next(c, s.return_state ?? "admit");
      return;
    }
    if (decision.gate_id === "G1") {
      for (const asset of this.config.assets) {
        const prior = this.read(slot(s, `intent-${asset.asset_id}`), AssetIntentV1Schema);
        setSlot(
          c,
          s,
          `intent-${asset.asset_id}`,
          this.seal(
            c,
            "asset-intent",
            { ...prior, scope_status: "approved", gate_scope_ref: ref },
            [ref]
          )
        );
      }
      // Approval selects new intent versions. The first preview effect must bind
      // a ledger containing those versions and G1, not the pre-approval snapshot.
      this.refreshLedger(c);
    }
    const next = Object.entries({
      G1: "asset_prepare",
      G2: "animatic_plan",
      G3: "shot_prepare",
      G4: "final_prepare",
      G5: "delivery_prepare",
    }).find(([g]) => g === decision.gate_id)?.[1];
    if (next === undefined) throw new Error("gate continuation missing");
    this.next(c, next);
  }
  invalidate(c: RunContext, target: string): void {
    const s = executionState(c),
      cut =
        target === "story_plan" || target === "script_text"
          ? 0
          : target === "asset_prepare"
            ? 1
            : target === "animatic_plan"
              ? 2
              : target === "rough_build" || target === "shot_prepare"
                ? 3
                : 4;
    const removed = s.slots.filter(
      (x) => gateIds.findIndex((g) => g === x.slot) >= cut && gateIds.some((g) => g === x.slot)
    );
    s.slots = s.slots.filter((x) => !removed.includes(x));
    // Preserve immutable gate-answer history until the engine records this response. Current
    // authority comes exclusively from the owner approval index and live slot selections.

    s.shot_index = 0;
    s.asset_index = 0;
    saveExecution(c, s);
    this.next(c, target);
  }
  /** A host-issued campaign allowance, not physical capacity or a new legal/effect grant.
   * Actual capacity is still atomically held and metered by the generic operation owner. */
  effectBudget(
    c: RunContext,
    recipe: VideogenEffectRecipeV1,
    gate: ArtifactRef,
    predecessor: ArtifactRef,
    state?: VideogenExecutionStateV1
  ): ArtifactRef {
    const policy = recipe.budget_policy;
    if (policy === undefined) {
      // Legacy synthetic provider requests remain available only in explicitly isolated tests.
      const provider = this.providers.effects.get(recipe.kind);
      if (
        this.config.context !== "isolated_fixture" ||
        provider?.declaration.request.schema_id !== "penny.effect-fixture-request.v1" ||
        recipe.budget_ref === undefined
      )
        throw new Error("VIDEOGEN_CURRENT_BUDGET_POLICY_REQUIRED");
      return recipe.budget_ref;
    }
    if (recipe.budget_ref !== undefined) throw new Error("VIDEOGEN_AMBIGUOUS_BUDGET_POLICY");
    if (new Set(policy.meters.map((m) => m.meter)).size !== policy.meters.length)
      throw new Error("duplicate recipe budget meter");
    const s = state ?? executionState(c),
      key = `budget-${sha256(canonicalJson({ state: c.stateId, visit: this.checkpointer.stateVisits(c.identity.run_id).filter((v) => v.state_id === c.stateId).length + c.pendingStateVisits().filter((v) => v.state_id === c.stateId).length, kind: recipe.kind, subject: recipe.subject_id, index: s.effect_index, gate, predecessor }))}`;
    const existing = s.slots.find((row) => row.slot === key)?.ref;
    if (existing !== undefined) {
      const held = validateBudgetReservation(
        this.read(existing, BudgetReservationV1Schema),
        this.config.limits
      );
      if (
        !sameRef(held.scope_gate_ref, gate) ||
        held.operation_kind !== recipe.kind ||
        held.state !== "held" ||
        Date.parse(held.expires_at_utc) <= Date.now()
      )
        throw new Error("VIDEOGEN_CURRENT_BUDGET_EXPIRED_OR_CHANGED");
      return existing;
    }
    const decision = validateGateDecision(
      this.read(gate, videogenSemanticSchema("penny.videogen-gate-decision.v1")),
      this.config.limits
    );
    const packet = validateGatePacket(
      this.read(decision.packet_ref, videogenSemanticSchema("penny.videogen-gate-packet.v1")),
      this.config.limits
    );
    if (
      decision.choice !== "approve" ||
      packet.kind !== "approval" ||
      decision.resulting_scope_digest !== gateScopeDigest(packet, decision.packet_ref)
    )
      throw new Error("VIDEOGEN_BUDGET_APPROVED_SCOPE_REQUIRED");
    const subject =
      recipe.kind === "local_delivery"
        ? validateVideoRequest(
            this.read(slot(s, "request"), videogenSemanticSchema("penny.videogen-request.v1")),
            this.config.limits
          ).destination_id
        : recipe.subject_id;
    if (
      recipe.kind !== "local_delivery" &&
      (!packet.effect_scope.kinds.includes(recipe.kind) ||
        !packet.effect_scope.subject_ids.includes(subject))
    )
      throw new Error("VIDEOGEN_BUDGET_SUBJECT_OUTSIDE_SCOPE");
    const prior = s.slots
      .filter((row) => row.slot.startsWith("budget-"))
      .map((row) =>
        validateBudgetReservation(this.read(row.ref, BudgetReservationV1Schema), this.config.limits)
      );
    for (const meter of policy.meters) {
      const total = prior.reduce(
        (n, r) => n + BigInt(r.meters.find((m) => m.meter === meter.meter)?.reserved ?? 0),
        BigInt(meter.reserved)
      );
      const cap =
        meter.meter === "stored_bytes"
          ? this.config.envelope.max_storage_bytes
          : meter.meter === "cost_microcredits"
            ? this.config.envelope.max_cost_units
            : meter.meter === "attempts"
              ? this.config.envelope.max_attempts
              : this.config.limits.max_integer;
      const reserve =
        recipe.stage === "asset" || recipe.stage === "draft" || recipe.stage === "rough"
          ? meter.meter === "stored_bytes"
            ? this.config.envelope.finish_reserve_bytes
            : meter.meter === "cost_microcredits"
              ? this.config.envelope.finish_reserve_cost_units
              : 0
          : 0;
      if (total > BigInt(cap - reserve)) throw new Error("VIDEOGEN_BUDGET_ENVELOPE_EXCEEDED");
      if (recipe.kind !== "local_delivery") {
        const scoped = packet.effect_scope.meters.find((m) => m.meter === meter.meter);
        const scopedTotal = prior
          .filter((r) => sameRef(r.scope_gate_ref, gate))
          .reduce(
            (n, r) => n + BigInt(r.meters.find((m) => m.meter === meter.meter)?.reserved ?? 0),
            BigInt(meter.reserved)
          );
        if (scoped === undefined || scopedTotal > BigInt(scoped.limit))
          throw new Error("VIDEOGEN_BUDGET_GATE_ALLOWANCE_EXCEEDED");
      }
    }
    const provider = this.providers.effects.get(recipe.kind);
    if (provider === undefined) throw new Error("budget provider missing");
    const declaration = provider.declaration;
    let capacity_policy_ref: ArtifactRef | null = null,
      capacity_binding_id: string | null = null;
    const capacity = this.providers.capacity_options;
    if (capacity !== undefined) {
      const actual = validateCapacityPolicy(capacity.policy);
      const matches = actual.bindings.filter(
        (b) =>
          b.operation_kind === recipe.kind &&
          b.adapter_id === declaration.adapter_id &&
          b.backend_binding_id === declaration.backend_binding_id &&
          hostCapacityWorkerKey(b.worker_id) === recipe.backend_key_sha256
      );
      const binding = matches[0];
      if (matches.length !== 1 || binding === undefined)
        throw new Error("VIDEOGEN_BUDGET_CAPACITY_BINDING_REQUIRED");
      capacity_binding_id = binding.binding_id;
      capacity_policy_ref = this.seal(
        c,
        "host-capacity-policy",
        actual,
        [],
        HostCapacityPolicyV1Schema,
        actual.schema_id
      );
    } else if (this.config.context === "production")
      throw new Error("VIDEOGEN_BUDGET_CAPACITY_OWNER_REQUIRED");
    const evidence = (kind: "queue" | "inactivity" | "cleanup", interval_ms: number) =>
      this.seal(
        c,
        "runtime-budget-policy",
        {
          schema_id: "penny.videogen-runtime-budget-policy.v1",
          schema_version: 1,
          kind,
          config_digest: this.binding_digest,
          operation_kind: recipe.kind,
          adapter_id: declaration.adapter_id,
          backend_binding_id: declaration.backend_binding_id,
          backend_key_sha256: recipe.backend_key_sha256,
          interval_ms,
          capacity_policy_ref,
          capacity_binding_id,
          scope_ref: gate,
        },
        [gate, ...(capacity_policy_ref === null ? [] : [capacity_policy_ref])],
        RuntimeBudgetPolicyEvidenceSchema
      );
    const created = Date.now();
    const value = validateBudgetReservation(
      {
        ...semantic("budget-reservation"),
        reservation_id: key,
        scope_gate_ref: gate,
        subject_id: subject,
        operation_kind: recipe.kind,
        meters: policy.meters.map((m) => ({ ...m, consumed: 0, unit: METER_UNITS[m.meter] })),
        created_at_utc: new Date(created).toISOString(),
        expires_at_utc: new Date(created + policy.lifetime_ms).toISOString(),
        policy_refs: {
          queue: evidence("queue", declaration.lease_profile.queue_inactivity_ms),
          inactivity: evidence("inactivity", declaration.operation_inactivity_ms),
          cleanup: evidence("cleanup", policy.lifetime_ms),
        },
        state: "held",
        reason: "prepared",
      },
      this.config.limits
    );
    const ref = this.seal(
      c,
      "budget-reservation",
      value,
      [gate, predecessor],
      BudgetReservationV1Schema
    );
    setSlot(c, s, key, ref);
    return ref;
  }
  effectDone(c: RunContext, kind: string, subject: string): boolean {
    const visit =
      this.checkpointer.stateVisits(c.identity.run_id).filter((v) => v.state_id === c.stateId)
        .length + c.pendingStateVisits().filter((v) => v.state_id === c.stateId).length;
    return executionState(c).effects.some(
      (e) =>
        e.state === c.stateId &&
        e.subject === subject &&
        this.checkpointer
          .hostOperationCallsForRun(c.identity.run_id)
          .some(
            (record) =>
              record.operation_id === e.operation_id &&
              record.operation_kind === kind &&
              record.directive.effect_identity?.visit === visit
          )
    );
  }
  /** Drive exactly the registered effect sequence; no effect runs inside a continuation. */
  effect(
    c: RunContext,
    kind: string,
    stage: string,
    subject: string,
    registration_sha256: string
  ): Directive | undefined {
    const s = executionState(c),
      recipes = this.providers.recipes.filter(
        (r) => r.kind === kind && r.stage === stage && r.subject_id === subject
      );
    const recipe = recipes[s.effect_index];
    if (recipe === undefined) {
      if (s.effect_index === 0)
        throw new Error(`VIDEOGEN_BINDING_MISSING: ${kind}/${stage}/${subject}`);
      s.effect_index = 0;
      saveExecution(c, s);
      return undefined;
    }
    const provider = this.providers.effects.get(kind);
    if (provider === undefined) throw new Error(`VIDEOGEN_PROVIDER_MISSING: ${kind}`);
    const declaration = provider.declaration;
    const gate = slot(
      s,
      stage === "asset"
        ? "G1"
        : stage === "draft" || stage === "rough"
          ? "G3"
          : stage === "delivery"
            ? "G5"
            : "G4"
    );
    if (
      kind === "kdenlive_build_verify" &&
      provider.native !== undefined &&
      s.slots.some((x) => x.slot === "master")
    ) {
      const previous = slot(s, "native_request"),
        request = this.read(previous, NativeBuildRequestV1Schema);
      if (
        request.accepted_master_ref === undefined ||
        !sameRef(request.accepted_master_ref, slot(s, "master"))
      )
        setSlot(
          c,
          s,
          "native_request",
          this.seal(
            c,
            "native-build-request",
            { ...request, accepted_master_ref: slot(s, "master") },
            [previous, slot(s, "master")]
          )
        );
    }
    let inputs =
      recipe.input_bindings?.map((row) => ({ slot: row.slot, ref: slot(s, row.source_slot) })) ??
      recipe.input_slots.map((name) => ({ slot: name, ref: slot(s, name) }));
    if (new Set(inputs.map((x) => x.slot)).size !== inputs.length)
      throw new Error("duplicate effect input port");
    const fields: Record<string, unknown> = { ...recipe.fields };
    for (const row of recipe.operands) fields[row.field] = slot(s, row.slot);
    if (fields.schema_id === "penny.videogen-voice-job-request.v1") {
      fields.script_ref = slot(s, "script");
      fields.script_rights_ref = slot(s, "script_rights");
      fields.chunk_plan_ref = slot(s, `chunk_plan-${subject}`);
      fields.asset_intent_ref = slot(s, `intent-${subject}`);
      fields.expected_chunk_ids = this.read(
        slot(s, `chunk_plan-${subject}`),
        VoiceStudioChunkPlanV1Schema
      ).chunks.map((chunk) => chunk.chunk_id);
    }
    if (
      (kind === "timeline_master" || kind === "kdenlive_build_verify") &&
      provider.native !== undefined
    ) {
      const requestRef = validateContract(
        ArtifactRefSchema,
        fields.native_build_request_ref,
        "native selected request"
      );
      const request = this.read(requestRef, NativeBuildRequestV1Schema);
      inputs = [
        { slot: "native-build", ref: requestRef },
        ...(kind === "kdenlive_build_verify" && request.accepted_master_ref !== undefined
          ? [{ slot: "master", ref: request.accepted_master_ref }]
          : []),
        ...request.assets.map((a, i) => ({ slot: `asset-${i}`, ref: a.source_ref })),
      ];
    }
    const predecessor = effectPredecessor(this, s, recipe, fields);
    const budget = this.effectBudget(c, recipe, gate, predecessor, s);
    if (fields.schema_id === "penny.videogen-delivery-operation-request.v1") {
      const old = slot(s, "delivery_intent");
      if (
        !sameRef(
          old,
          validateContract(ArtifactRefSchema, fields.delivery_intent_ref, "delivery operand")
        )
      )
        throw new Error("VIDEOGEN_CURRENT_DELIVERY_INTENT_REQUIRED");
      const intent = this.read(old, DeliveryIntentV1Schema);
      if (!sameRef(intent.budget_ref, budget)) {
        const next = this.seal(c, "delivery-intent", { ...intent, budget_ref: budget }, [
          old,
          budget,
        ]);
        setSlot(c, s, "delivery_intent", next);
        fields.delivery_intent_ref = next;
        for (const input of inputs) if (sameRef(input.ref, old)) input.ref = next;
      }
    }
    if (fields.schema_id === "penny.videogen-voice-job-request.v1") {
      fields.budget_reservation_ref = budget;
      fields.gate_decision_ref = gate;
      fields.selected_ledger_ref = slot(s, "L");
      const budgetValue = this.read(budget, BudgetReservationV1Schema);
      const profile = this.read(
        validateContract(ArtifactRefSchema, fields.profile_ref, "voice recipe profile"),
        Type.Union([VoiceStudioProfileV1Schema, VoiceApiProfileSchema])
      );
      fields.policy_refs = {
        schema_id: "penny.videogen-policy-binding.v1",
        schema_version: 1,
        queue_policy_ref: {
          ref: budgetValue.policy_refs.queue,
          max_wait_ms: declaration.lease_profile.queue_inactivity_ms,
          discipline: "FIFO",
        },
        inactivity_policy_ref: {
          ref: budgetValue.policy_refs.inactivity,
          active_inactivity_ms: declaration.operation_inactivity_ms,
          transport_silence_ms: profile.limits.silence_ms,
          renewal_source: "trusted_host_milestone",
        },
        cleanup_policy_ref: {
          ref: budgetValue.policy_refs.cleanup,
          cancel_grace_ms: recipe.budget_policy?.lifetime_ms ?? 1000,
          retention_ms: recipe.budget_policy?.lifetime_ms ?? 1000,
          quarantine_requires_operator_proof: true,
        },
      };
      const request = validateContract(
        VoiceStudioJobRequestV1Schema,
        { ...fields, operation_id: "pending" },
        "current voice recipe"
      );
      inputs = voiceStudioInputs(request, profile);
      for (const { ref } of inputs)
        if (!c.selectedArtifacts.some((x) => sameRef(x, ref))) c.selectedArtifacts.push(ref);
    }
    validateContract(
      provider.request_schema,
      { ...fields, operation_id: "effect_preflight" },
      "effect preflight"
    );
    const prepared = prepareHostEffectArtifacts({
      store: this.store,
      identity: {
        project_id: this.project_id,
        run_id: c.identity.run_id,
        state_id: c.stateId,
        visit:
          this.checkpointer.stateVisits(c.identity.run_id).filter((x) => x.state_id === c.stateId)
            .length + c.pendingStateVisits().filter((x) => x.state_id === c.stateId).length,
        attempt: 1,
        kind: recipe.kind,
        scope_ref: gate,
        predecessor_ref: predecessor,
        slot: `${stage}-${subject}-${s.effect_index}`,
      },
      request_contract: declaration.request,
      request_schema: provider.request_schema,
      request: fields,
      input_refs: inputs.map((x) => x.ref),
      budget_reservation_ref: budget,
      expected_output_contract_ref: recipe.output_contract_ref,
      ...(fields.schema_id === "penny.videogen-voice-job-request.v1"
        ? {
            profile_snapshot_ref: validateContract(
              ArtifactRefSchema,
              fields.profile_ref,
              "voice profile snapshot"
            ),
          }
        : {}),
    });
    const pending = validateDirective({
      schema_version: 2,
      host_operation_schema_version: 1,
      action: "invoke_host_operation",
      identity: c.identity,
      state_id: c.stateId,
      attempt: 1,
      operation_id: prepared.operation_id,
      operation_kind: kind,
      registration_sha256,
      request_ref: prepared.request_ref,
      request_sha256: prepared.request_ref.content_digest,
      effect_intent_ref: prepared.effect_intent_ref,
      effect_identity: prepared.effect_identity,
      input_artifacts: { schema_version: 2, artifacts: inputs },
      expected_result: declaration.result,
      policy_binding: hostOperationPolicyBinding(declaration, recipe.backend_key_sha256),
    });
    const record = this.checkpointer.hostOperationCallForDirective(
      c.identity.run_id,
      c.stateId,
      1,
      prepared.operation_id
    );
    if (record === undefined) {
      c.pendingDirective = pending;
      return pending;
    }
    if (record.lifecycle !== "settled" && record.lifecycle !== "consumed") {
      c.pendingDirective = record.directive;
      return record.directive;
    }
    if (record.disposition?.outcome !== "completed" || record.result_wrapper?.ref == null)
      throw new Error(`VIDEOGEN_EFFECT_NOT_SUCCEEDED: ${kind}`);
    verifyHostResultWrapper(this.store, record);
    // Recovery/terminal bytes are not current authority. Re-run concrete native/delivery
    // inspection while the engine is preparing the continuation, before its consumption CAS.
    if (
      kind === "kdenlive_build_verify" ||
      kind === "local_delivery" ||
      kind === "timeline_master"
    ) {
      const adapter = provider.createAdapter({
        owner: new VideogenOwnerSelection({
          store: this.store,
          checkpointer: this.checkpointer,
          project_id: this.project_id,
          run_id: c.identity.run_id,
        }),
        store: this.store,
        checkpointer: this.checkpointer,
      });
      const binding = adapter.inspectRequest({
        directive: record.directive,
        declaration,
        request_bytes: this.store.read(record.request_ref),
        input_artifacts: record.directive.input_artifacts,
      });
      if (
        binding.operation_kind !== kind ||
        binding.adapter_id !== record.policy_binding.adapter_id ||
        binding.backend_binding_id !== record.policy_binding.backend_binding_id ||
        binding.backend_key_sha256 !== record.policy_binding.backend_key_sha256
      )
        throw new Error("VIDEOGEN_CONSUME_PROVIDER_BINDING_DRIFT");
    }
    if (!s.effects.some((x) => x.operation_id === record.operation_id))
      s.effects.push({
        operation_id: record.operation_id,
        state: c.stateId,
        subject,
        wrapper_ref: record.result_wrapper.ref,
      });
    if (
      (kind === "video_render" || kind === "voice_job") &&
      record.operation_result_ref &&
      record.host_receipt_ref
    ) {
      setSlot(c, s, `source-result-${subject}`, record.operation_result_ref);
      setSlot(c, s, `source-receipt-${subject}`, record.host_receipt_ref);
    }
    const products = [
      ...(record.operation_result_ref === null ? [] : [record.operation_result_ref]),
      ...record.output_artifacts,
    ];
    for (const ref of products) {
      const schema = ref.content_schema?.schema_id;
      const destination =
        ref.media_type === "video/mp4"
          ? kind === "timeline_master"
            ? stage === "rough"
              ? "rough_cut"
              : "master"
            : `clip-${subject}`
          : schema === "penny.videogen-video-evidence.v1"
            ? stage === "rough"
              ? "rough_video"
              : stage === "finished"
                ? "master_video"
                : `video-${subject}`
            : schema === "penny.videogen-audio-evidence.v1"
              ? stage === "rough"
                ? "rough_audio"
                : stage === "finished"
                  ? "master_audio"
                  : `audio_evidence-${subject}`
              : schema === "penny.videogen-audio-source.v1"
                ? `audio_source-${subject}`
                : schema === "penny.videogen-edit-decision.v1"
                  ? stage === "rough"
                    ? "rough_edit"
                    : "final_edit"
                  : schema === "penny.videogen-native-build-result.v1"
                    ? "native"
                    : schema === "penny.videogen-portable-package.v1"
                      ? "manifest"
                      : schema === "penny.videogen-delivery-receipt.v1"
                        ? "delivery"
                        : undefined;
      if (destination !== undefined) {
        readExact(this.store, this.project_id, ref, this.config.envelope.max_output_bytes);
        if (ref.media_type === "application/json" && schema?.startsWith("penny.videogen-"))
          readVideogenStageProduct({
            artifacts: this.store,
            project_id: this.project_id,
            ref,
            schema_id: schema,
            limits: this.config.limits,
          });
        setSlot(c, s, destination, ref);
        if (
          ref.media_type === "video/mp4" &&
          (kind === "video_render" || kind === "timeline_master")
        ) {
          let sources = (recipe.rights_source_slots ?? []).map((name) => slot(s, name));
          if (kind === "timeline_master" && provider.native !== undefined) {
            const request = this.read(
              validateContract(
                ArtifactRefSchema,
                fields.native_build_request_ref,
                "timeline rights request"
              ),
              NativeBuildRequestV1Schema
            );
            sources = request.assets.map((a) => a.source_ref);
          }
          if (sources.length > 0)
            this.inheritRights(
              c,
              ref,
              sources,
              record.host_receipt_ref ?? record.result_wrapper.ref,
              "video"
            );
        }
      }
      if (schema === "penny.videogen-voice-api-raw-result.v1")
        materializeRuntimeVoice(this, c, record.operation_record_id, registration_sha256, subject);
      if (schema === "penny.videogen-native-media-result.v1")
        materializeRuntimeMedia(
          this,
          c,
          record.operation_record_id,
          registration_sha256,
          stage,
          subject
        );
      if (schema === "penny.videogen-native-raw-result.v1")
        materializeRuntimeNative(this, c, record.operation_record_id, registration_sha256);
      if (schema === "penny.videogen-delivery-raw-result.v1") {
        const raw: unknown = JSON.parse(this.store.readById(ref.artifact_id).toString("utf8"));
        const r = validateContract(RawDeliveryResultV1Schema, raw, "delivery result");
        setSlot(
          c,
          s,
          "delivery",
          this.seal(
            c,
            "delivery-receipt",
            {
              ...semantic("delivery-receipt"),
              destination_id: r.destination_id,
              exclusive_stage_id: r.exclusive_stage_id,
              final_namespace_id: r.final_namespace_id,
              g5_packet_digest: r.g5_packet_digest,
              master_digest: r.master_digest,
              project_digest: r.project_digest,
              manifest_digest: r.manifest_digest,
              readback_refs: [ref],
              fsync_atomicity_ref: record.host_receipt_ref,
              outcome: r.outcome,
            },
            [ref, record.result_wrapper.ref]
          )
        );
      }
    }
    s.effect_index++;
    saveExecution(c, s);
    return this.effect(c, kind, stage, subject, registration_sha256);
  }
  informationCallKey(
    c: RunContext,
    trigger: NonNullable<VideogenRuntimeProvidersV1["information_triggers"]>[number]
  ): string {
    const s = executionState(c),
      inputs = trigger.input_slots.map((name) => ({ slot: name, ref: slot(s, name) }));
    return `information-${trigger.trigger_state}-${sha256(canonicalJson({ request: trigger.request, inputs })).slice(0, 24)}`;
  }
  childOutput(c: RunContext, record: ChildWorkflowCallRecord): ArtifactRef | undefined {
    if (record.lifecycle !== "consumed" && record.lifecycle !== "terminal_recorded")
      return undefined;
    const resultRef = c.selectedArtifacts.find(
      (x) => x.kind === "child-result" && x.operation_id === `child-result:${record.call_id}`
    );
    if (resultRef === undefined) return undefined;
    const result = validateChildWorkflowResult(
      JSON.parse(
        readExact(
          this.store,
          this.project_id,
          resultRef,
          this.config.limits.max_json_bytes
        ).toString("utf8")
      )
    );
    if (
      result.call_id !== record.call_id ||
      result.parent_run_id !== c.identity.run_id ||
      result.call_key !== record.call_key ||
      result.terminal_sha256 !== record.terminal_sha256 ||
      result.terminal_action !== "complete" ||
      !result.met ||
      result.output_artifact === null ||
      canonicalJson(result.output_artifact) !== canonicalJson(record.output_artifact) ||
      !c.selectedArtifacts.some((x) => canonicalJson(x) === canonicalJson(result.output_artifact))
    )
      throw new Error("VIDEOGEN_CHILD_NOT_ACCEPTED: exact complete owner terminal required");
    return result.output_artifact;
  }
  host(c: RunContext, registration_sha256: string): Directive | undefined {
    let s = executionState(c);
    const shot = s.shot_ids[s.shot_index];
    const run = (kind: string, stage: string, subject = shot ?? "production") =>
      this.effect(c, kind, stage, subject, registration_sha256);
    if (c.stateId === "child_call") {
      const origin = s.information_origin,
        trigger = this.providers.information_triggers?.find((x) => x.trigger_state === origin),
        authority = this.providers.information_child;
      if (origin === undefined || trigger === undefined || authority === undefined)
        throw new Error("VIDEOGEN_INFORMATION_BINDING_MISSING");
      const target = authority.parent_policy.targets.find(
        (x) => x.child_name === trigger.child_name
      );
      if (target === undefined) throw new Error("information child target not authorized");
      const callKey = this.informationCallKey(c, trigger);
      const record = this.checkpointer.childWorkflowCallForParent(
        c.identity.run_id,
        "child_call",
        callKey
      );
      const output = record === undefined ? undefined : this.childOutput(c, record);
      if (output !== undefined) {
        setSlot(c, s, `information-${origin}`, output);
        delete s.information_origin;
        saveExecution(c, s);
        this.next(c, origin);
        return;
      }
      const binding = {
        schema_version: 1,
        project_id: this.project_id,
        principal_id: "host:videogen",
        scope_id: origin,
        source_policy_id: authority.authorization_id,
        destination_policy_id: "information-only",
      };
      const request = validateChildWorkflowRequest({
        schema_id: "penny.child-workflow-request.v1",
        schema_version: 1,
        child_name: trigger.child_name,
        provider_request_schema_id: target.native_request.schema_id,
        provider_request_schema_version: target.native_request.schema_version,
        provider_request: trigger.request,
        policy_binding: binding,
      });
      // Native parser and unchanged provider authority are mandatory before any call reservation.
      const templateRegistration = PLAYBOOK_REGISTRY.get("videogen");
      if (templateRegistration === undefined) throw new Error("videogen registration missing");
      validateGenericChildProviderRequest(
        "videogen",
        request,
        new Map([
          ...PLAYBOOK_REGISTRY,
          [
            "videogen",
            {
              ...templateRegistration,
              information_child: authority,
            },
          ],
        ])
      );
      const content = canonicalJson(request),
        operation_id = `child-request:${sha256(content)}`;
      const requestRef =
        this.store.refFor(
          c.identity.run_id,
          "child_call",
          null,
          "child-request",
          operation_id,
          1
        ) ??
        this.store.persist({
          metadata: {
            schema_version: 2,
            run_id: c.identity.run_id,
            phase: "child_call",
            branch_id: null,
            kind: "child-request",
            operation_id,
            version: 1,
            producer: "host:videogen",
            media_type: "application/json",
            content_schema: { schema_id: request.schema_id, schema_version: 1 },
            parent_ref: null,
            upstream_refs: trigger.input_slots.map((name) => slot(s, name)),
          },
          content,
        });
      if (
        readExact(
          this.store,
          this.project_id,
          requestRef,
          this.config.limits.max_json_bytes
        ).toString() !== content
      )
        throw new Error("information child immutable request conflict");
      const inputs = trigger.input_slots.map((name) => ({ slot: name, ref: slot(s, name) }));
      const directive = validateDirective({
        schema_version: 3,
        action: "invoke_child_workflow",
        identity: c.identity,
        state_id: c.stateId,
        call_key: callKey,
        child_name: trigger.child_name,
        request_ref: requestRef,
        input_artifacts: { schema_version: 2, artifacts: inputs },
        expected_output: target.expected_output,
        policy_binding: binding,
        progress_lease: target.progress_lease,
      });
      c.pendingDirective = directive;
      return directive;
    }
    if (c.stateId === "asset_prepare") {
      const intents = this.config.assets.map((a) => {
        const source = s.slots.find(
          (x) => x.slot === `png-${a.asset_id}` || x.slot === `audio_source-${a.asset_id}`
        )?.ref;
        return {
          asset_id: a.asset_id,
          intent_ref: slot(s, `intent-${a.asset_id}`),
          state:
            source === undefined
              ? a.purpose === "voice_preview" || a.purpose === "performance"
                ? "pending_voice"
                : "pending_image"
              : "captured",
          ...(source === undefined ? {} : { source_ref: source }),
          ...(s.slots.find((x) => x.slot === `audio_evidence-${a.asset_id}`)
            ? { audio_evidence_ref: slot(s, `audio_evidence-${a.asset_id}`) }
            : {}),
        };
      });
      const pending =
        intents.find((x) => x.state === "pending_image") ??
        intents.find((x) => x.state === "pending_voice");
      setSlot(
        c,
        s,
        "assets",
        this.seal(c, "admitted-asset-ledger", {
          ...semantic("admitted-asset-ledger"),
          story_ref: slot(s, "canon"),
          g1_decision_ref: slot(s, "G1"),
          intents,
          required_image_ids: this.config.assets
            .filter((a) => a.purpose !== "voice_preview" && a.purpose !== "performance")
            .map((a) => a.asset_id),
          required_voice_ids: this.config.assets
            .filter((a) => a.purpose === "voice_preview" || a.purpose === "performance")
            .map((a) => a.asset_id),
          ...(pending ? { next_asset_id: pending.asset_id } : {}),
        })
      );
      if (pending !== undefined)
        s.asset_index = this.config.assets.findIndex((a) => a.asset_id === pending.asset_id);
      saveExecution(c, s);
      this.next(
        c,
        pending?.state === "pending_image"
          ? "image_child"
          : pending?.state === "pending_voice"
            ? "voice_capture"
            : "look_check"
      );
      return;
    }
    if (c.stateId === "voice_capture") {
      const a = this.config.assets[s.asset_index];
      if (a === undefined) throw new Error("voice selection missing");
      const kinds =
        a.source === "voice_studio"
          ? [
              "voice_job",
              ...(this.providers.recipes.some(
                (recipe) =>
                  recipe.kind === "media_decode_extract" &&
                  recipe.stage === "asset" &&
                  recipe.subject_id === a.asset_id
              )
                ? ["media_decode_extract"]
                : []),
            ]
          : ["media_decode_extract"];
      for (const kind of kinds) {
        if (this.effectDone(c, kind, a.asset_id)) continue;
        const d = run(kind, "asset", a.asset_id);
        if (d) return d;
      }
      s = executionState(c);
      this.next(c, "asset_prepare");
      return;
    }
    if (c.stateId === "image_child") {
      const asset = this.config.assets[s.asset_index];
      if (asset === undefined) throw new Error("image asset missing");
      const template = this.providers.image_requests?.get(asset.asset_id),
        policy = this.providers.imagegen_child;
      if (template === undefined || policy === undefined)
        throw new Error(
          "VIDEOGEN_IMAGE_CHILD_BINDING_MISSING: controlled policy and native request required"
        );
      validateImagegenChildPolicy(policy);
      const intentRef = slot(s, `intent-${asset.asset_id}`),
        intent = this.read(intentRef, AssetIntentV1Schema);
      const callKey = this.imageCallKey(c, asset.asset_id);
      const record = this.checkpointer.childWorkflowCallForParent(
        c.identity.run_id,
        c.stateId,
        callKey
      );
      const imported = record === undefined ? undefined : this.childOutput(c, record);
      if (imported !== undefined) {
        const ref = imported;
        const value = validateContract(
          ImageAssetResultV1Schema,
          JSON.parse(
            readExact(this.store, this.project_id, ref, this.config.limits.max_json_bytes).toString(
              "utf8"
            )
          ),
          "native image asset result"
        );
        if (canonicalJson(value.intent_ref) !== canonicalJson(intentRef))
          throw new Error("image child intent is stale");
        setSlot(c, s, `png-${asset.asset_id}`, value.png_ref);
        setSlot(c, s, `image_result-${asset.asset_id}`, ref);
        if (value.origin === "fresh") {
          if (
            value.render_receipt_ref === null ||
            value.validity_ref === null ||
            value.quality_ref === null ||
            record === undefined
          )
            throw new Error("VIDEOGEN_REVIEWED_IMAGE_LINEAGE_REQUIRED");
          const renderReceipt = value.render_receipt_ref;
          const journals = this.checkpointer.hostOperationCallsForRun(record.child_identity.run_id);
          if (
            !journals.some(
              (j) =>
                j.lifecycle === "consumed" &&
                j.disposition?.outcome === "completed" &&
                j.host_receipt_ref !== null &&
                j.operation_result_ref !== null &&
                sameRef(j.operation_result_ref, renderReceipt) &&
                j.output_artifacts.some((r) => sameRef(r, value.png_ref))
            )
          )
            throw new Error("VIDEOGEN_REVIEWED_IMAGE_JOURNAL_REQUIRED");
          const rights = this.inheritRights(
            c,
            value.png_ref,
            [intent.story_ref],
            value.render_receipt_ref,
            "image"
          );
          setSlot(c, s, `rights-${asset.asset_id}`, rights);
        }
        this.next(c, "asset_prepare");
        return;
      }
      if (
        intent.scope_status !== "approved" ||
        !policy.asset_ids.includes(asset.asset_id) ||
        template.count !== 1 ||
        template.export !== null
      )
        throw new Error("image child exceeds G1 private policy");
      const native = validateImagegenRequest({
        ...template,
        asset: this.imageAsset(c, asset.asset_id),
      });
      const binding = {
        schema_version: 1,
        project_id: this.project_id,
        principal_id: "host:videogen",
        scope_id: asset.asset_id,
        source_policy_id: policy.authorization_id,
        destination_policy_id: "no-export",
      };
      const request = validateChildWorkflowRequest({
        schema_id: "penny.child-workflow-request.v1",
        schema_version: 1,
        child_name: "imagegen",
        provider_request_schema_id: "penny.imagegen-request.v1",
        provider_request_schema_version: 1,
        provider_request: native,
        policy_binding: binding,
      });
      const operation_id = `child-request:${sha256(canonicalJson(request))}`;
      const requestRef =
        this.store.refFor(c.identity.run_id, c.stateId, null, "child-request", operation_id, 1) ??
        this.store.persist({
          metadata: {
            schema_version: 2,
            run_id: c.identity.run_id,
            phase: c.stateId,
            branch_id: null,
            kind: "child-request",
            operation_id,
            version: 1,
            producer: "host:videogen",
            media_type: "application/json",
            content_schema: { schema_id: request.schema_id, schema_version: 1 },
            parent_ref: null,
            upstream_refs: [intentRef],
          },
          content: canonicalJson(request),
        });
      readExact(this.store, this.project_id, requestRef, this.config.limits.max_json_bytes);
      const input = native.asset?.input;
      const operands =
        input?.kind === "revision"
          ? [
              { slot: "source_png", ref: input.source_ref },
              ...(input.area.kind === "mask"
                ? [{ slot: "mask_png", ref: input.area.mask_ref }]
                : []),
            ]
          : [];
      const directive = validateDirective({
        schema_version: 3,
        action: "invoke_child_workflow",
        identity: c.identity,
        state_id: c.stateId,
        call_key: callKey,
        child_name: "imagegen",
        request_ref: requestRef,
        input_artifacts: { schema_version: 2, artifacts: operands },
        expected_output: IMAGEGEN_CHILD_OUTPUT,
        policy_binding: binding,
        progress_lease: policy.progress_lease,
      });
      c.pendingDirective = directive;
      return directive;
    }
    if (c.stateId === "animatic_build") {
      if (this.config.single_shot_edit) prepareSingleShotEdit(this, c, "animatic");
      const plan = validateVideogenWorker(
        "animatic_plan",
        this.read(
          slot(s, "animatic_plan"),
          videogenSemanticSchema("penny.videogen-animatic-plan.v1")
        )
      );
      if (!("boards" in plan)) throw new Error("animatic plan required");
      if (canonicalJson(plan.boards.map((x) => x.shot_id)) !== canonicalJson(s.shot_ids))
        throw new Error("animatic must cover all canonical shots in order");
      setSlot(
        c,
        s,
        "animatic",
        this.seal(c, "animatic", {
          ...semantic("animatic"),
          story_ref: slot(s, "canon"),
          look_ref: slot(s, "look"),
          boards: plan.boards.map((b) => ({
            shot_id: b.shot_id,
            png_ref: slot(s, `png-${b.board_asset_id}`),
            start: b.start,
            duration: b.duration,
          })),
          ...(plan.voice_status === "none" ? {} : { voice_ref: slot(s, "performance") }),
          voice_status: plan.voice_status,
          shot_routes: s.shot_ids.map((id) => slot(s, `route-${id}`)),
          edit_ref: slot(s, "animatic_edit"),
          review_ref: slot(s, "objective-reference"),
        })
      );
      this.next(c, "g3");
      return;
    }
    if (c.stateId === "shot_prepare") {
      if (
        this.providers.recipes.some(
          (r) => r.kind === "reference_upload" && r.stage === "draft" && r.subject_id === shot
        )
      ) {
        const d = run("reference_upload", "draft");
        if (d) return d;
        s = executionState(c);
      }
      this.next(c, "draft_apply");
      return;
    }
    if (c.stateId === "draft_apply" || c.stateId === "final_apply") {
      const stage = c.stateId === "draft_apply" ? "draft" : "final";
      // Distinct effect cursors survive each operation in the fixed render→decode chain.
      const renderDone = s.effects.some(
        (e) =>
          e.state === c.stateId &&
          e.subject === shot &&
          this.checkpointer
            .hostOperationCallsForRun(c.identity.run_id)
            .some(
              (r) =>
                r.operation_id === e.operation_id &&
                r.operation_kind === "video_render" &&
                r.directive.effect_identity?.visit ===
                  this.checkpointer
                    .stateVisits(c.identity.run_id)
                    .filter((x) => x.state_id === c.stateId).length +
                    c.pendingStateVisits().filter((x) => x.state_id === c.stateId).length
            )
      );
      if (!renderDone) {
        const d = run("video_render", stage);
        if (d) return d;
        s = executionState(c);
      }
      const d = run("media_decode_extract", stage);
      if (d) return d;
      s = executionState(c);
      if (shot === undefined) throw new Error("shot selection missing");
      const evidence = this.read(slot(s, `video-${shot}`), VideoEvidenceV1Schema);
      if (evidence.source_clip_ref.artifact_id !== slot(s, `clip-${shot}`).artifact_id)
        throw new Error("decode does not bind current clip");
      setSlot(
        c,
        s,
        `media-${shot}`,
        this.seal(c, "shot-media", {
          ...semantic("shot-media"),
          shot_id: shot,
          stage,
          clip_ref: slot(s, `clip-${shot}`),
          route_ref: slot(s, `route-${shot}`),
          video_evidence_ref: slot(s, `video-${shot}`),
          ledger_ref: slot(s, "L"),
          audio_policy: "strip_source_audio",
        })
      );
      this.next(c, stage === "draft" ? "draft_verify" : "final_verify");
      return;
    }
    if (c.stateId === "final_prepare") {
      this.next(c, "final_apply");
      return;
    }
    if (c.stateId === "rough_build" || c.stateId === "finish_apply") {
      const finished = c.stateId === "finish_apply",
        stage = finished ? "finished" : "rough";
      if (
        !finished &&
        this.config.single_shot_edit &&
        !s.slots.some((row) => row.slot === "rough_edit_template")
      ) {
        prepareSingleShotEdit(this, c, "rough");
        s = executionState(c);
      }
      const preparedKey = `rough_prepared_${this.checkpointer.stateVisits(c.identity.run_id).filter((v) => v.state_id === c.stateId).length + c.pendingStateVisits().filter((v) => v.state_id === c.stateId).length}`;
      if (
        !finished &&
        !s.slots.some((x) => x.slot === preparedKey) &&
        s.slots.some((x) => x.slot === "rough_edit_template")
      ) {
        const template = this.read(slot(s, "rough_edit_template"), EditDecisionV1Schema);
        const drafts = s.shot_ids.map((id) =>
          this.read(slot(s, `draft-${id}`), ShotResultV1Schema)
        );
        const originals = [
          ...new Set(
            template.tracks
              .filter((t) => t.kind === "video")
              .flatMap((t) =>
                t.items.filter((i) => i.kind === "clip").map((i) => i.source_ref.artifact_id)
              )
          ),
        ];
        if (originals.length !== drafts.length)
          throw new Error("rough edit template/shot replacement coverage");
        const tracks = template.tracks.map((track) => ({
          ...track,
          items: track.items.map((item) => {
            if (item.kind === "clip") {
              const source =
                track.kind === "video"
                  ? drafts[originals.indexOf(item.source_ref.artifact_id)]?.clip_ref
                  : item.source_ref;
              if (!source) throw new Error("rough edit current source missing");
              setSlot(c, s, `edit_asset_${source.content_digest.slice(0, 24)}`, source);
              return { ...item, source_ref: source };
            }
            if (item.kind === "caption") {
              const original = item.style_ref,
                style = this.read(original, EditCaptionStyleV1Schema);
              setSlot(c, s, `edit_asset_${original.content_digest.slice(0, 24)}`, original);
              setSlot(
                c,
                s,
                `edit_asset_${style.font_ref.content_digest.slice(0, 24)}`,
                style.font_ref
              );
              setSlot(
                c,
                s,
                `edit_asset_${item.text_source_ref.content_digest.slice(0, 24)}`,
                item.text_source_ref
              );
              const currentStyle = this.seal(
                c,
                "edit-caption-style",
                style,
                [original],
                EditCaptionStyleV1Schema
              );
              this.inheritRights(c, currentStyle, [original], original, "text");
              setSlot(c, s, `edit_style_${currentStyle.content_digest.slice(0, 24)}`, currentStyle);
              return { ...item, style_ref: currentStyle };
            }
            return item;
          }),
        }));
        this.refreshLedger(c);
        const edit = {
          ...template,
          tracks,
          decision_notes_ref: slot(s, `draft-${s.shot_ids[0]}`),
          source_dependency_ledger_ref: slot(s, "L"),
        };
        setSlot(
          c,
          s,
          "rough_edit",
          this.seal(c, "edit-decision", edit, [
            slot(s, "rough_edit_template"),
            ...s.shot_ids.map((id) => slot(s, `draft-${id}`)),
          ])
        );
        setSlot(
          c,
          s,
          "rough_native_request",
          bindRuntimeNativeRequest(this, c, slot(s, "rough_edit"))
        );
        setSlot(c, s, preparedKey, slot(s, "rough_edit"));
      }
      const kinds = finished
        ? ["timeline_master", "media_decode_extract", "kdenlive_build_verify"]
        : ["timeline_master", "media_decode_extract"];
      for (const kind of kinds) {
        const done = s.effects.some(
          (e) =>
            e.state === c.stateId &&
            e.subject === "production" &&
            this.checkpointer
              .hostOperationCallsForRun(c.identity.run_id)
              .some(
                (r) =>
                  r.operation_id === e.operation_id &&
                  r.operation_kind === kind &&
                  r.directive.effect_identity?.visit ===
                    this.checkpointer
                      .stateVisits(c.identity.run_id)
                      .filter((x) => x.state_id === c.stateId).length +
                      c.pendingStateVisits().filter((x) => x.state_id === c.stateId).length
              )
        );
        if (done) continue;
        const d = run(kind, stage, "production");
        if (d) return d;
        s = executionState(c);
      }
      if (
        finished &&
        this.read(slot(s, "native"), NativeBuildResultV1Schema).status !== "qualified"
      )
        throw new Error("VIDEOGEN_NATIVE_UNQUALIFIED");
      this.next(c, finished ? "master_verify" : "rough_review");
      return;
    }
    if (c.stateId === "finish_prepare") {
      const rough = this.read(slot(s, "rough_edit"), EditDecisionV1Schema);
      const sourceLedger = this.read(rough.source_dependency_ledger_ref, DependencyLedgerV1Schema);
      for (const node of sourceLedger.nodes) {
        // Final capture replaces the typed video-source selection; retaining its draft
        // descriptor would present an unused source to the exact edit inspector.
        if (node.ref.content_schema?.schema_id === "penny.videogen-edit-source.v1") continue;
        if (node.status !== "current")
          throw new Error("final preparation requires current rough dependencies");
        setSlot(c, s, `edit_ancestor_${node.stable_id}`, node.ref);
      }
      this.refreshLedger(c);
      const finals = s.shot_ids.map((id) => this.read(slot(s, `final-${id}`), ShotResultV1Schema));
      const { edit, replacements } = deriveFinalEdit(rough, finals, slot(s, "L"));
      setSlot(
        c,
        s,
        "final_edit",
        this.seal(c, "edit-decision", edit, [
          slot(s, "rough_edit"),
          slot(s, "G4"),
          ...s.shot_ids.map((id) => slot(s, `final-${id}`)),
        ])
      );
      setSlot(c, s, "final_edit_ledger", slot(s, "L"));
      void replacements;
      setSlot(c, s, "native_request", bindRuntimeNativeRequest(this, c, slot(s, "final_edit")));
      this.next(c, "finish_apply");
      return;
    }
    if (c.stateId === "delivery_prepare") {
      const native = this.read(slot(s, "native"), NativeBuildResultV1Schema),
        request = validateVideoRequest(
          this.read(slot(s, "request"), videogenSemanticSchema("penny.videogen-request.v1")),
          this.config.limits
        );
      setSlot(
        c,
        s,
        "delivery_intent",
        this.seal(c, "delivery-intent", {
          ...semantic("delivery-intent"),
          destination_id: request.destination_id,
          g5_decision_ref: slot(s, "G5"),
          master_ref: slot(s, "master"),
          manifest_ref: slot(s, "manifest"),
          project_ref: native.normalized_project_ref,
          staging_id: `stage_${sha256(c.identity.run_id).slice(0, 24)}`,
          exclusive_final_id: `delivery_${sha256(c.identity.run_id).slice(0, 24)}`,
          rights_check_ref: this.read(slot(s, "manifest"), PortableManifestV1Schema)
            .rights_ledger_ref,
          budget_ref: slot(s, "G5"),
        })
      );
      this.next(c, "delivery_apply");
      return;
    }
    if (c.stateId === "delivery_apply") {
      const d = run("local_delivery", "delivery", "production");
      if (d) return d;
      s = executionState(c);
      this.next(c, "completion_check");
      return;
    }
    if (c.stateId === "completion_check") return this.terminal(c, "delivered");
    throw new Error(`unhandled videogen host state: ${c.stateId}`);
  }
  terminal(
    c: RunContext,
    status: "delivered" | "incomplete" | "cancelled" | "error",
    reason?: string
  ): Directive {
    const s = executionState(c),
      get = (name: string) => s.slots.find((x) => x.slot === name)?.ref;
    const value = validateContract(
      VideogenTerminalV1Schema,
      {
        ...semantic("terminal"),
        ...(get("master") ? { master_ref: get("master") } : {}),
        ...(get("manifest") ? { package_manifest_ref: get("manifest") } : {}),
        ...(get("delivery") ? { delivery_ref: get("delivery") } : {}),
        gate_decision_refs: gateIds.flatMap((id) => (get(id) ? [slot(s, id)] : [])),
        ledger_ref: slot(s, "L"),
        ...(get("rights_closure") ? { rights_evidence_ref: get("rights_closure") } : {}),
        ...(get("master_review") ? { master_review_ref: get("master_review") } : {}),
        ...(get("package_review") ? { package_review_ref: get("package_review") } : {}),
        unresolved_operation_ids: this.checkpointer
          .hostOperationCallsForRun(c.identity.run_id)
          .filter((x) => x.lifecycle !== "consumed" && x.lifecycle !== "settled")
          .map((x) => x.operation_id),
        status,
        met: status === "delivered",
        best_valid_refs: s.slots
          .filter((x) => ["master", "manifest", "delivery"].includes(x.slot))
          .map((x) => x.ref),
      },
      "videogen terminal"
    );
    const ref = this.seal(c, "terminal", value);
    setSlot(c, s, "terminal", ref);
    const d = validateDirective({
      schema_version: 2,
      action: status === "delivered" ? "complete" : status,
      status: status === "delivered" ? "complete" : status,
      identity: c.identity,
      met: status === "delivered",
      result: { output_artifact_ref: ref, context: this.config.context },
      artifacts: [ref],
      unresolved: reason ? [reason] : [],
    });
    c.status = status === "delivered" ? "complete" : status;
    c.met = status === "delivered";
    c.pendingDirective = d;
    c.terminalDirective = d;
    return d;
  }
}
