/** Isolated protocol fixtures only. Constructed pictures/audio/native records are NOT live
 * qualifiers, legal clearance, decoder qualification or actual editor interoperability. */
import path from "node:path";
import { mkdirSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { ArtifactStore, previewArtifactRef } from "../../dist/artifact-store.js";
import { Checkpointer } from "../../dist/checkpointer.js";
import { canonicalJson, sha256 } from "../../dist/canonical-json.js";
import {
  validateContract,
  type ArtifactRef,
  type HostOperationArtifactContractV1,
} from "../../dist/contracts.js";
import { HostOperationLeaseAuthority } from "../../dist/host-operations/lease-authority.js";
import { HostOperationRuntimeOwner } from "../../dist/host-operations/owner.js";
import type {
  HostOperationAdapterV1,
  HostOperationArtifactWriteV1,
  HostOperationDeclarationV1,
} from "../../dist/host-operations/contracts.js";
import { initializePennyState } from "../../dist/state/index.js";
import { loadRuntimeConfig } from "../../dist/config.js";
import { validateGatePacket } from "../../dist/videogen/gates.js";
import { effectDeclaration, EFFECT_REQUEST_SCHEMA, EFFECT_RESULT } from "./host-effect-fixture.js";
import { FoundationFixture } from "./videogen-foundation-fixtures.js";
import { setup } from "./videogen-executor-fixture.js";
import { audioFixture } from "./videogen-audio-fixtures.js";
import { editFixture, packageFixture } from "./videogen-edit-fixtures.js";
import { videogenStageAudio } from "./videogen-stage-fixtures.js";
import { encodeCanonicalPng } from "../../dist/png-media.js";
import { executionState, slot } from "../../dist/videogen/execution-state.js";
import {
  validateVideogenPrivateConfig,
  type VideogenRuntimeProvidersV1,
  type VideogenEffectRecipeV1,
  type VideogenEffectProviderV1,
} from "../../dist/videogen/runtime-config.js";
import { LocalDeliveryFiles } from "../../dist/videogen/delivery-files.js";
import { DeliveryIntentV1Schema } from "../../dist/videogen/delivery.js";
import { NativeBuildResultV1Schema } from "../../dist/videogen/stage-contracts.js";
import { OrchestrationRunner } from "../../dist/worker.js";
const semantic = (name: string) => ({ schema_id: `penny.videogen-${name}.v1`, schema_version: 1 });
const contract = (name: string): HostOperationArtifactContractV1 => ({
  schema_version: 1,
  port_name: name,
  artifact_kind: `videogen-${name}`,
  schema_id: `penny.videogen-${name}.v1`,
  schema_version_required: 1,
});
const outputNames = [
  "fixture-clip",
  "fixture-native-project",
  "fixture-proof",
  "fixture-proof1",
  "fixture-proof2",
  "fixture-proof3",
  "fixture-proof4",
  "video-evidence",
  "audio-evidence",
  "edit-decision",
  "native-build-result",
  "portable-package",
  "delivery-raw-result",
];
export class CompleteVideogenFixture extends FoundationFixture {
  declare readonly project_id: string;
  declare readonly store: ArtifactStore;
  declare readonly checkpointer: Checkpointer;
  readonly stateRoot: string;
  constructor() {
    super();
    this.stateRoot = path.join(this.root, "state");
    this.store.close();
    this.checkpointer.close();
    initializePennyState(this.root, { env: { PENNY_STATE_ROOT: this.stateRoot } });
    const config = loadRuntimeConfig(this.root, { PENNY_STATE_ROOT: this.stateRoot });
    this.project_id = config.projectId;
    this.store = ArtifactStore.openExisting(config.artifactRoot, { projectId: this.project_id });
    this.checkpointer = Checkpointer.openExisting(config.dbPath, undefined, {
      projectId: this.project_id,
    });
    const repository = path.resolve(import.meta.dirname, "../../../..");
    symlinkSync(path.join(repository, ".pi"), path.join(this.root, ".pi"), "dir");
    symlinkSync(path.join(repository, "docs"), path.join(this.root, "docs"), "dir");
  }
}
export async function completeFixture(f: CompleteVideogenFixture) {
  const e = editFixture(f),
    p = packageFixture(f, e),
    audio = audioFixture(f),
    png = f.raw(
      encodeCanonicalPng({ width: 1, height: 1, rgba: Buffer.from([20, 40, 80, 255]) }),
      "image/png"
    ),
    r = f.opaque("isolated fixture dependency; not production evidence"),
    pngRights = f.rights(png);
  const base = setup(f).providers;
  const audioEvidence = f.json(
    videogenStageAudio(audio.source.media_ref),
    "penny.videogen-audio-evidence.v1"
  );
  const look = f.json(
    {
      ...semantic("look-voice"),
      story_ref: r,
      approved_pngs: [],
      style_sheet_ref: r,
      voice_identity: { voice_id: "fixture", source: "supplied", language: "en", consent_ref: r },
      performance_ref: audio.source.media_ref,
      audio_evidence_ref: audioEvidence,
      timing_ref: r,
      license_refs: [],
      preview_receipts: [],
      known_limits: ["silent fixture; not heard speech"],
    },
    "penny.videogen-look-voice.v1"
  );
  const nativeRequest = f.json(
    {
      ...semantic("native-build-request"),
      edit_ref: e.edit_ref,
      assets: [{ source_ref: e.video, role: "video", relative_path: "assets/shot1.mp4" }],
      fixture_digest: "a".repeat(64),
      editor_build_digest: "a".repeat(64),
      mlt_build_digest: "a".repeat(64),
      feature_subset_digest: "a".repeat(64),
      output_root_selector: "fixture",
      limits: {
        max_xml_bytes: 100000,
        max_assets: 100,
        max_duration_frames: 10000,
        max_normalize_ms: 10000,
      },
    },
    "penny.videogen-native-build-request.v1"
  );
  const config = validateVideogenPrivateConfig({
    ...base.config,
    rights: f.current_rights,
    assets: [
      base.config.assets[0],
      {
        schema_id: "penny.videogen-asset-intent.v1",
        schema_version: 1,
        asset_id: "voice1",
        purpose: "performance",
        source: "supplied",
        input_refs: [audio.source.media_ref],
        allowed_change: "none",
        preserve_criteria: ["fixture"],
        consent_ref: r,
        rights_ref: audio.source.rights_ref,
        estimated_meters: [{ meter: "attempts", reserved: 1 }],
        attempt_limit: 1,
      },
    ],
    initial_products: [
      { slot: "licensed_source", ref: e.video },
      { slot: "png-image1", ref: png },
      { slot: "audio_source-voice1", ref: audio.source_ref },
      { slot: "audio_evidence-voice1", ref: audioEvidence },
      { slot: "look_template", ref: look },
      { slot: "performance", ref: audio.source.media_ref },
      { slot: "animatic_edit", ref: e.edit_ref },
      { slot: "native_request_template", ref: nativeRequest },
      { slot: "rights_closure", ref: r },
      { slot: "source_closure", ref: r },
      { slot: "feature_subset", ref: r },
      { slot: "delivery_budget", ref: r },
    ],
  });
  void pngRights;
  const destination = path.join(f.root, "destination");
  mkdirSync(destination, { mode: 0o700 });
  const files = new LocalDeliveryFiles([
    {
      destination_id: "fixture-local",
      root: destination,
      max_files: 100,
      max_bytes: 10000000,
      reserve_bytes: 1,
    },
  ]);
  let posts = 0;
  let capturedPlayback: ArtifactRef | undefined;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
      void _;
    }
    posts++;
    res.end("constructed fixture video; NOT playable AV");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture listener missing");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const recipes: VideogenEffectRecipeV1[] = [];
  for (const [stage, subject, kinds] of [
    ["draft", "shot1", ["video_render", "media_decode_extract"]],
    ["final", "shot1", ["video_render", "media_decode_extract"]],
    ["rough", "production", ["timeline_master", "media_decode_extract"]],
    [
      "finished",
      "production",
      ["timeline_master", "media_decode_extract", "kdenlive_build_verify"],
    ],
    ["delivery", "production", ["local_delivery"]],
  ] as const)
    for (const kind of kinds)
      recipes.push({
        kind,
        stage,
        rights_source_slots: ["licensed_source"],
        subject_id: subject,
        fields: { schema_id: "penny.effect-fixture-request.v1", schema_version: 1, value: stage },
        operands: [],
        input_slots: [],
        predecessor_slot: "L", // Explicit synthetic-provider operand; never a concrete adapter default.
        budget_ref: r,
        output_contract_ref: r,
        backend_key_sha256: sha256(kind),
      });
  const effects = new Map<string, VideogenEffectProviderV1>();
  const adapters = new Map<string, HostOperationAdapterV1>();
  for (const kind of new Set(recipes.map((x) => x.kind))) {
    const declaration: HostOperationDeclarationV1 = {
      ...effectDeclaration(),
      operation_kind: kind,
      adapter_id: `isolated-fixture-${kind}`,
      backend_binding_id: `isolated-fixture-${kind}`,
      max_output_artifacts: 32,
      max_output_bytes: 10000000,
      output_contracts: outputNames.map(contract),
      result_selection_policy: "unselected",
    };
    const adapter: HostOperationAdapterV1 = {
      adapter_id: declaration.adapter_id,
      inspectRequest() {
        return {
          schema_version: 1,
          operation_kind: kind,
          adapter_id: declaration.adapter_id,
          backend_binding_id: declaration.backend_binding_id,
          backend_key_sha256: sha256(kind),
        };
      },
      async run(ctx) {
        const request = validateContract(
            EFFECT_REQUEST_SCHEMA,
            JSON.parse(Buffer.from(ctx.request_bytes).toString()),
            "fixture request"
          ),
          stage = request.value,
          c = f.checkpointer.loadRun(ctx.directive.identity),
          s = executionState(c);
        if (kind !== "video_render") {
          ctx.beginSubmission();
          ctx.recordRemoteAccepted(`local-${ctx.directive.operation_id}`);
        }
        const outputs: HostOperationArtifactWriteV1[] = [];
        const add = (name: string, value: unknown, media = "application/json"): ArtifactRef => {
          const write = {
            contract: contract(name),
            media_type: media,
            content:
              value instanceof Uint8Array
                ? value
                : media === "application/json"
                  ? canonicalJson(value)
                  : String(value),
          };
          const index = outputs.length;
          outputs.push(write);
          return previewArtifactRef({
            metadata: {
              schema_version: 2,
              run_id: c.identity.run_id,
              phase: c.stateId,
              branch_id: null,
              kind: write.contract.artifact_kind,
              operation_id: `host-operation-output:${ctx.journal.operation_record_id}:${index}`,
              version: 1,
              producer: `host:${declaration.adapter_id}`,
              media_type: media,
              content_schema: { schema_id: write.contract.schema_id, schema_version: 1 },
              parent_ref: null,
              upstream_refs: [
                ctx.directive.request_ref,
                ...(ctx.directive.effect_intent_ref ? [ctx.directive.effect_intent_ref] : []),
                ...ctx.directive.input_artifacts.artifacts.map((x) => x.ref),
              ],
            },
            content: write.content,
          });
        };
        if (kind === "video_render") {
          ctx.beginSubmission();
          const response = await fetch(endpoint, {
            method: "POST",
            body: Buffer.from(ctx.request_bytes),
          });
          ctx.recordRemoteAccepted(`fixture-${posts}`);
          const bytes = Buffer.from(await response.arrayBuffer());
          ctx.recordFetched({
            schema_version: 1,
            content_sha256: sha256(bytes),
            byte_length: bytes.length,
            item_count: 1,
            poll_count: 0,
          });
          add("fixture-clip", bytes, "video/mp4");
        }
        if (kind === "timeline_master") {
          add("fixture-clip", `constructed ${stage} cut; NOT playable`, "video/mp4");
          if (stage === "rough") add("edit-decision", e.edit);
        }
        if (kind === "media_decode_extract") {
          const target = slot(
              s,
              stage === "rough" ? "rough_cut" : stage === "finished" ? "master" : "clip-shot1"
            ),
            proof = add("fixture-proof", {
              context: "isolated_fixture",
              target_digest: target.content_digest,
              notice: "synthetic decode; no CPU qualification",
            });
          add("video-evidence", {
            ...semantic("video-evidence"),
            source_clip_ref: target,
            decode_profile_ref: r,
            container_validation_ref: proof,
            full_decode_ref: proof,
            frames: [{ index: 0, pts: { numerator: 0, denominator: 1 }, png_ref: png }],
            limits: {
              max_frames: 1,
              max_bytes: 1000000,
              selection_rule_id: "span-boundaries-and-nearest-even-v1",
            },
            unassessed: ["motion", "speech", "sound", "sync"],
          });
          if (stage === "rough" || stage === "finished")
            add("audio-evidence", videogenStageAudio(target));
        }
        if (kind === "kdenlive_build_verify") {
          const project = add(
            "fixture-native-project",
            "<isolated-fixture-not-qualified/>",
            "application/x-kdenlive"
          );
          const proofs = Array.from({ length: 4 }, (_, index) =>
            add(`fixture-proof${index + 1}`, {
              context: "isolated_fixture",
              index,
              notice: "synthetic native interoperability; NOT editor qualification",
            })
          );
          const [open, reopen, relocate, compare] = proofs;
          if (!open || !reopen || !relocate || !compare) throw new Error("proof fixture");
          add("native-build-result", {
            ...semantic("native-build-result"),
            project_ref: project,
            normalized_project_ref: project,
            roundtrip_edit_ref: slot(s, "final_edit"),
            dependency_refs: [],
            open_save_receipt_ref: open,
            reopen_receipt_ref: reopen,
            relocation_receipt_ref: relocate,
            render_comparison_ref: compare,
            diagnostics: ["TRUSTED ISOLATED FIXTURE ONLY; NOT PRODUCTION QUALIFICATION"],
            status: "qualified",
          });
          const master = slot(s, "master"),
            documentation = f.opaque(
              "Fixture products are not usable media or an editable film.",
              "text/plain"
            );
          const payload = [
            {
              relative_path: "master.mp4",
              role: "master",
              producer_ref: master,
              sha256: master.content_digest,
              bytes: master.byte_length,
              media_type: master.media_type,
              used_by: [],
            },
            {
              relative_path: "project.kdenlive",
              role: "project",
              producer_ref: project,
              sha256: project.content_digest,
              bytes: project.byte_length,
              media_type: project.media_type,
              used_by: [],
            },
            {
              relative_path: "README.txt",
              role: "documentation",
              producer_ref: documentation,
              sha256: documentation.content_digest,
              bytes: documentation.byte_length,
              media_type: documentation.media_type,
              used_by: [],
            },
          ];
          add("portable-package", {
            ...p.manifest,
            package_id: "fixture_complete",
            accepted_master: {
              relative_path: "master.mp4",
              sha256: master.content_digest,
              bytes: master.byte_length,
              format: "mp4",
              duration: { numerator: 1, denominator: 1 },
            },
            native_project: {
              relative_path: "project.kdenlive",
              sha256: project.content_digest,
              bytes: project.byte_length,
              kdenlive_version: "fixture-only",
              mlt_version: "fixture-only",
            },
            files: payload,
            reference_graph: [],
            clip_to_timeline: [],
            instructions_relative_path: "README.txt",
          });
          capturedPlayback = f.json(
            {
              ...semantic("playback-review"),
              target_ref: master,
              target_digest: master.content_digest,
              reviewer_kind: "human",
              reviewer_id: "isolated-fixture-human",
              playback_device_profile_ref: r,
              complete_viewing: true,
              heard_audio: true,
              observations: [
                {
                  time: { numerator: 0, denominator: 1 },
                  criterion: "fixture",
                  verdict: "pass",
                  note: "synthetic attestation; no playback occurred",
                },
              ],
              motion_verdict: "pass",
              speech_verdict: "pass",
              sync_verdict: "pass",
              identity_verdict: "pass",
              recorded_at_utc: new Date().toISOString(),
              attestation_ref: r,
            },
            "penny.videogen-playback-review.v1"
          );
        }
        if (kind === "local_delivery") {
          const intent = validateContract(
              DeliveryIntentV1Schema,
              JSON.parse(f.store.readById(slot(s, "delivery_intent").artifact_id).toString()),
              "fixture delivery intent"
            ),
            native = validateContract(
              NativeBuildResultV1Schema,
              JSON.parse(f.store.readById(slot(s, "native").artifact_id).toString()),
              "fixture native result"
            );
          const payload = [
            {
              relative_path: "master.mp4",
              bytes: f.store.readById(slot(s, "master").artifact_id),
              sha256: slot(s, "master").content_digest,
            },
            {
              relative_path: "project.kdenlive",
              bytes: f.store.readById(native.project_ref.artifact_id),
              sha256: native.project_ref.content_digest,
            },
          ];
          files.prepare("fixture-local", intent.staging_id, payload, ctx.signal);
          const readback = files.apply(
            "fixture-local",
            intent.staging_id,
            intent.exclusive_final_id,
            payload,
            ctx.signal
          );
          const approvals = c.playbookData.videogen_owner_selection;
          void approvals;
          const g5packet = c.selectedArtifacts.find(
            (x) =>
              x.content_schema?.schema_id === "penny.videogen-gate-packet.v1" &&
              validateGatePacket(
                JSON.parse(f.store.readById(x.artifact_id).toString()),
                config.limits
              ).gate_id === "G5"
          );
          if (g5packet === undefined) throw new Error("G5 fixture missing");
          add("delivery-raw-result", {
            ...semantic("delivery-raw-result"),
            operation_id: request.operation_id,
            destination_id: "fixture-local",
            exclusive_stage_id: intent.staging_id,
            final_namespace_id: intent.exclusive_final_id,
            g5_packet_digest: g5packet.content_digest,
            master_digest: slot(s, "master").content_digest,
            project_digest: native.project_ref.content_digest,
            manifest_digest: slot(s, "manifest").content_digest,
            readback,
            publication: "private_exclusive_namespace_atomic_products_rename",
            outcome: "succeeded",
          });
        }
        if (kind !== "video_render") {
          const bytes = Buffer.from(canonicalJson(outputs));
          ctx.recordFetched({
            schema_version: 1,
            content_sha256: sha256(bytes),
            byte_length: bytes.length,
            item_count: outputs.length,
            poll_count: 0,
          });
        }
        const disposition = {
          outcome: "completed",
          remote_disposition: "proven_terminal",
          lease_disposition: "released",
          retryable: false,
          reason_code: null,
        } as const;
        const persisted = ctx.persist({
          disposition,
          operation_result: {
            contract: EFFECT_RESULT,
            media_type: "application/json",
            content: canonicalJson({
              context: "isolated_fixture",
              operation_id: request.operation_id,
            }),
          },
          outputs,
        });
        return { ...persisted, disposition };
      },
    };
    adapters.set(declaration.adapter_id, adapter);
    effects.set(kind, {
      declaration,
      request_schema: EFFECT_REQUEST_SCHEMA,
      createAdapter: () => adapter,
    });
  }
  const providers: VideogenRuntimeProvidersV1 = {
    project_id: f.project_id,
    config,
    recipes,
    effects,
  };
  const configured = setup(f, providers);
  const leases = new HostOperationLeaseAuthority(f.stateRoot),
    owner = new HostOperationRuntimeOwner({
      projectId: f.project_id,
      checkpointer: f.checkpointer,
      artifacts: f.store,
      leaseAuthority: leases,
      adapters,
    });
  return {
    ...configured,
    providers,
    runner: new OrchestrationRunner(configured.engine, configured.worker, undefined, owner),
    destination,
    posts: () => posts,
    playbackRef: () => {
      if (capturedPlayback === undefined) throw new Error("fixture playback not ready");
      return capturedPlayback;
    },
    close: async () => {
      files[Symbol.dispose]();
      leases.close();
      server.close();
      await once(server, "close");
    },
  };
}
