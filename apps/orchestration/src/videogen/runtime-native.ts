import { Type } from "typebox";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import type { RunContext } from "../context.js";
import type { VideogenRuntime } from "./runtime.js";
import { executionState, slot, setSlot } from "./execution-state.js";
import {
  NativeBuildRequestV1Schema,
  NativeBuildTemplateV1Schema,
  type NativeBuildRequestV1,
} from "./native-contracts.js";
import {
  EditCaptionStyleV1Schema,
  EditDecisionV1Schema,
  EditFeatureSubsetV1Schema,
  EditQuantizationV1Schema,
} from "./edit-contracts.js";
import { NativeProductProducer } from "./native-products.js";
import { produceNativePortableManifest } from "./native-package-producer.js";
import { inspectEditDecision } from "./edit-decision.js";
import { currentAdapterHost } from "./native-owner-authority.js";
import { VideogenOwnerSelection, readVideogenOwnerSelection } from "./owner-selection.js";
import { portablePathFor } from "./portable-package.js";
import { CurrentRightsV1Schema } from "./rights-ledger.js";
import { CrossRunEdgeV1Schema } from "./rights-ledger.js";
import { NativeBuildResultV1Schema } from "./stage-contracts.js";
import { sameRef } from "./bounds.js";

/** Derive only resource addresses from the selected edit. No template-supplied stale asset or
 * accepted master survives a changed draft/final selection. */
export function bindRuntimeNativeRequest(
  r: VideogenRuntime,
  c: RunContext,
  editRef: ArtifactRef
): ArtifactRef {
  const s = executionState(c),
    template = r.read(
      slot(s, "native_request_template"),
      Type.Union([NativeBuildRequestV1Schema, NativeBuildTemplateV1Schema])
    ),
    edit = r.read(editRef, EditDecisionV1Schema);
  const assets: NativeBuildRequestV1["assets"] = [];
  const add = (
    source_ref: ArtifactRef,
    role: (typeof assets)[number]["role"],
    pathRole: Parameters<typeof portablePathFor>[1]
  ) => {
    r.store.read(source_ref);
    const selected = c.selectedArtifacts.find((ref) => ref.artifact_id === source_ref.artifact_id);
    if (selected && !sameRef(selected, source_ref))
      throw new Error("native resource selected ref drift");
    if (!selected) c.selectedArtifacts.push(source_ref);
    if (!assets.some((a) => sameRef(a.source_ref, source_ref)))
      assets.push({ source_ref, role, relative_path: portablePathFor(source_ref, pathRole) });
  };
  for (const track of edit.tracks)
    for (const item of track.items) {
      if (item.kind === "clip")
        add(
          item.source_ref,
          track.kind === "video" ? "video" : "voice",
          track.kind === "video"
            ? "original_video"
            : track.kind === "voice"
              ? "voice_stem"
              : "original_audio"
        );
      if (item.kind === "caption") {
        add(item.text_source_ref, "caption_dependency", "caption_source");
        add(item.style_ref, "caption_dependency", "documentation");
        add(
          r.read(item.style_ref, EditCaptionStyleV1Schema).font_ref,
          "caption_dependency",
          "documentation"
        );
      }
    }
  const fields = validateContract(
    NativeBuildTemplateV1Schema,
    {
      ...Object.fromEntries(
        Object.entries(template).filter(
          ([key]) => !["edit_ref", "accepted_master_ref", "assets"].includes(key)
        )
      ),
      schema_id: "penny.videogen-native-build-template.v1",
    },
    "native policy template"
  );
  return r.seal(
    c,
    "native-build-request",
    { ...fields, schema_id: "penny.videogen-native-build-request.v1", edit_ref: editRef, assets },
    [editRef, slot(s, "native_request_template")],
    NativeBuildRequestV1Schema
  );
}

export function runtimeNativeHost(r: VideogenRuntime, c: RunContext) {
  const provider = r.providers.effects.get("kdenlive_build_verify"),
    native = provider?.native;
  if (native === undefined) throw new Error("VIDEOGEN_NATIVE_COMPOSITION_MISSING");
  const owner = new VideogenOwnerSelection({
    store: r.store,
    checkpointer: r.checkpointer,
    project_id: r.project_id,
    run_id: c.identity.run_id,
  });
  const h = readVideogenOwnerSelection(owner);
  const current = currentAdapterHost(owner, {
    ...h.gate,
    ...h.rights,
    edit_policy: native.edit_policy,
    current_dependencies: [],
    measured_source_refs: [],
    audio_sources: [],
  }).host;
  const selection = validateContract(
    Type.Object({
      rights: Type.Array(CurrentRightsV1Schema),
      cross_run_edge_refs: Type.Array(ArtifactRefSchema),
    }),
    c.playbookData.videogen_owner_selection,
    "prepared current rights"
  );
  return {
    ...current,
    current_rights: selection.rights,
    cross_run_edges: selection.cross_run_edge_refs.map((ref) => r.read(ref, CrossRunEdgeV1Schema)),
  };
}

/** Exact completed owner custody is the only route from raw native bytes to runtime products. */
export function materializeRuntimeNative(
  r: VideogenRuntime,
  c: RunContext,
  operationRecordId: string,
  registration: string
): void {
  const provider = r.providers.effects.get("kdenlive_build_verify"),
    native = provider?.native,
    owners = r.providers.host_owners;
  if (!provider || !native || !owners) throw new Error("VIDEOGEN_NATIVE_CUSTODY_OWNER_REQUIRED");
  const record = r.checkpointer.hostOperationCall(operationRecordId);
  if (!record) throw new Error("VIDEOGEN_NATIVE_JOURNAL_REQUIRED");
  const producer = new NativeProductProducer({
    project_id: r.project_id,
    store: r.store,
    checkpointer: r.checkpointer,
    leases: owners.leases,
    limits: r.config.limits,
    registration_sha256: registration,
    declaration: provider.declaration,
    backend_key_sha256: record.policy_binding.backend_key_sha256,
    registry: native.registry,
  });
  const product = producer.produce(operationRecordId, runtimeNativeHost(r, c)),
    s = executionState(c);
  if (
    !sameRef(product.edit_ref, slot(s, "final_edit")) ||
    !sameRef(product.accepted_master_ref, slot(s, "master"))
  )
    throw new Error("VIDEOGEN_NATIVE_CURRENT_OPERANDS_REQUIRED");
  setSlot(c, s, "native", product.native_ref);
  setSlot(c, s, "native_operation", record.request_ref);
  const sources = product.required_assets.map((a) => a.source_ref);
  r.inheritRights(c, product.normalized_project_ref, sources, product.receipt_ref, "text");
  const config = r.config.portable;
  if (!config) throw new Error("missing_input: videogen portable documentation/environment policy");
  // Bootstrap templates are inert data. Copy document bytes to this run, preserving caller
  // content; feature-subset and quantization receive their actual semantic validators.
  const copy = (name: string, ref: ArtifactRef, schema?: typeof EditFeatureSubsetV1Schema) => {
    const content = r.store.read(ref);
    if (schema)
      return r.seal(c, name, r.read(ref, schema), [ref], schema, schema.properties.schema_id.const);
    return r.store.persist({
      metadata: {
        schema_version: 2,
        run_id: c.identity.run_id,
        phase: c.stateId,
        branch_id: null,
        kind: `videogen-${name}`,
        operation_id: `${record.operation_id}:${name}`,
        version: 1,
        producer: "host:videogen",
        media_type: ref.media_type,
        parent_ref: null,
        upstream_refs: [ref],
      },
      content,
    });
  };
  const credits = copy("credits", config.credits_ref),
    provenance = copy("package-provenance", config.provenance_ref),
    instructions = copy("instructions", config.instructions_ref),
    subset = copy("edit-feature-subset", config.feature_subset_ref, EditFeatureSubsetV1Schema);
  const host = { ...runtimeNativeHost(r, c), package_policy: config.package_policy };
  const closure = inspectEditDecision(host, product.edit_ref);
  const quant = r.seal(
    c,
    "edit-quantization",
    closure.quantization,
    [product.edit_ref],
    EditQuantizationV1Schema
  );
  const packaged = produceNativePortableManifest({
    producer,
    operation_record_id: operationRecordId,
    host,
    edit_ref: product.edit_ref,
    package_id: config.package_id,
    credits_ref: credits,
    provenance_ref: provenance,
    feature_subset_ref: subset,
    quantization_ref: quant,
    instructions_ref: instructions,
    environment: config.environment,
    environment_files: config.environment_files,
  });
  const manifest = r.seal(c, "portable-package", packaged.manifest, [
    product.native_ref,
    product.edit_ref,
    quant,
  ]);
  r.inheritRights(c, manifest, sources, product.receipt_ref, "text");
  setSlot(c, s, "manifest", manifest);
  setSlot(c, s, "feature_subset", subset);
  // These documents describe the exact checked closure; they issue no rights or release grant.
  for (const name of ["rights_closure", "source_closure"])
    setSlot(
      c,
      s,
      name,
      r.seal(
        c,
        "package-closure",
        {
          schema_id: "penny.videogen-package-closure.v1",
          schema_version: 1,
          manifest_ref: manifest,
          native_ref: product.native_ref,
          edit_ref: product.edit_ref,
          rights_refs: host.current_rights.map((x) => x.rights_ref),
          payload_refs: packaged.manifest.files.map((x) => x.producer_ref),
        },
        [manifest, product.native_ref],
        Type.Object(
          {
            schema_id: Type.Literal("penny.videogen-package-closure.v1"),
            schema_version: Type.Literal(1),
            manifest_ref: ArtifactRefSchema,
            native_ref: ArtifactRefSchema,
            edit_ref: ArtifactRefSchema,
            rights_refs: Type.Array(ArtifactRefSchema),
            payload_refs: Type.Array(ArtifactRefSchema),
          },
          { additionalProperties: false }
        )
      )
    );
  const result = r.read(product.native_ref, NativeBuildResultV1Schema);
  if (!r.store.read(result.roundtrip_edit_ref).equals(r.store.read(product.edit_ref)))
    throw new Error("native exact roundtrip changed");
}
