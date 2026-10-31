import { validateImagegenRequest } from "../skill-contracts/imagegen.js";
import { ArtifactStore } from "../artifact-store.js";
import { Checkpointer } from "../checkpointer.js";
import { canonicalJson } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import { checkGateApproval } from "../videogen/gates.js";
import { AssetIntentV1Schema, validateAssetIntent } from "../videogen/foundation-contracts.js";
import { readSemantic, sameRef } from "../videogen/bounds.js";
import { checkRights } from "../videogen/rights-ledger.js";
import {
  ImageAssetCriteriaV1Schema,
  ImageAssetCallV1Schema,
  ImageAssetResultV1Schema,
  validateImageInputUploadReceipt,
  type ImageAssetRequestV1,
} from "./reference-contracts.js";
import { readVideogenOwnerSelection, VideogenOwnerSelection } from "../videogen/owner-selection.js";
import { readReferencePng, editMask } from "./reference-media.js";

/** The sole authority input is an opaque concrete project/checkpointer binding. No live index
 * or snapshot supplied by a caller can become current approval, intent or rights authority. */
const authorities = new WeakMap<object, VideogenOwnerSelection>();
function authorityHost(value: unknown) {
  const owner = typeof value === "object" && value !== null ? authorities.get(value) : undefined;
  if (owner === undefined || Object.getPrototypeOf(value) !== ImageAssetAuthority.prototype)
    throw new Error("concrete image asset authority required");
  return readVideogenOwnerSelection(owner);
}
export class ImageAssetAuthority {
  constructor(owner: unknown) {
    if (new.target !== ImageAssetAuthority)
      throw new Error("concrete image asset authority required");
    readVideogenOwnerSelection(owner);
    if (!(owner instanceof VideogenOwnerSelection))
      throw new Error("concrete videogen owner required");
    authorities.set(this, owner);
    Object.freeze(this);
  }
  assertScope(
    store: ArtifactStore,
    checkpointer: Checkpointer,
    parentRunId: string,
    projectId: string
  ): void {
    assertImageAssetScope(this, store, checkpointer, parentRunId, projectId);
  }
  check(asset: ImageAssetRequestV1, runId: string, profileSha: string, maxRenders: number) {
    return checkImageAsset(this, asset, runId, profileSha, maxRenders);
  }
  media(asset: ImageAssetRequestV1) {
    return imageAssetMedia(this, asset);
  }
  verifyUpload(ref: ArtifactRef, runId: string, backendKey: string) {
    return verifyImageAssetUpload(this, ref, runId, backendKey);
  }
}
Object.freeze(ImageAssetAuthority.prototype);
Object.freeze(ImageAssetAuthority);

/** Validate concrete custody without granting any call or effect. */
export function assertImageAssetAuthority(
  authority: unknown
): asserts authority is ImageAssetAuthority {
  authorityHost(authority);
}

export function assertImageAssetOwners(
  authority: unknown,
  store: unknown,
  checkpointer?: unknown
): void {
  const host = authorityHost(authority);
  if (
    host.gate.store !== store ||
    (checkpointer !== undefined && host.gate.checkpointer !== checkpointer)
  )
    throw new Error("image asset authority belongs to different concrete owners");
}

/** Read the actual engine-owned request, not an adapter-supplied asset or proof callback. */
export function checkImageAssetRun(authority: unknown, runId: string, profileSha: string): void {
  const host = authorityHost(authority);
  const run = host.gate.checkpointer.loadRunById(runId);
  const refs = run?.selectedArtifacts.filter((ref) => ref.kind === "imagegen-request");
  if (refs?.length !== 1 || refs[0] === undefined)
    throw new Error("asset run has no exact native request");
  const request = validateImagegenRequest(
    JSON.parse(host.gate.store.read(refs[0]).toString("utf8"))
  );
  if (request.asset === undefined) throw new Error("asset run lost its native asset binding");
  checkImageAsset(
    authority,
    request.asset,
    runId,
    profileSha,
    request.count * (1 + request.max_revision_rounds)
  );
}

export function assertImageAssetScope(
  authority: unknown,
  store: ArtifactStore,
  checkpointer: Checkpointer,
  parentRunId: string,
  projectId: string
): void {
  const host = authorityHost(authority);
  if (
    store !== host.gate.store ||
    checkpointer !== host.gate.checkpointer ||
    parentRunId !== host.gate.run_id ||
    projectId !== host.gate.project_id
  )
    throw new Error("image asset authority belongs to a different parent or project");
  store.assertBoundProject(projectId);
}
export function imageAssetMedia(authority: unknown, asset: ImageAssetRequestV1) {
  const host = authorityHost(authority);
  if (asset.input.kind !== "revision") throw new Error("revision source missing");
  const source = readReferencePng(host.gate.store, asset.input.source_ref, "source");
  const supplied =
    asset.input.area.kind === "mask"
      ? readReferencePng(host.gate.store, asset.input.area.mask_ref, "mask")
      : undefined;
  return { source, mask: editMask(source, asset, supplied) };
}
export function verifyImageAssetUpload(
  authority: unknown,
  ref: ArtifactRef,
  runId: string,
  backendKey: string
) {
  const host = authorityHost(authority);
  const store = host.gate.store;
  const receipt = validateImageInputUploadReceipt(JSON.parse(store.read(ref).toString("utf8")));
  const record = host.gate.checkpointer.hostOperationCall(receipt.operation_record_id);
  if (
    record === undefined ||
    record.identity.run_id !== runId ||
    record.operation_kind !== "imagegen.comfyui-upload-input.v1" ||
    record.policy_binding.backend_key_sha256 !== backendKey ||
    record.lifecycle !== "consumed" ||
    record.operation_result_ref === null ||
    !sameRef(record.operation_result_ref, ref) ||
    record.disposition?.outcome !== "completed" ||
    record.host_receipt_ref === null ||
    record.platform_result_ref === null
  )
    throw new Error("input upload has no exact settled owner journal");
  store.read(record.host_receipt_ref);
  store.read(record.platform_result_ref);
  return receipt;
}
export function checkImageAsset(
  authority: unknown,
  asset: ImageAssetRequestV1,
  runId: string,
  profileSha: string,
  maxRenders: number
) {
  const host = authorityHost(authority);
  const { gate, rights } = host;
  const parent = gate.checkpointer.loadRunById(gate.run_id);
  if (
    parent === null ||
    parent === undefined ||
    ["cancelled", "error", "complete", "incomplete"].includes(parent.status)
  )
    throw new Error("asset parent is not current active work");
  const g1 = gate.current_approvals.find((x) => x.gate_id === "G1");
  if (g1 === undefined) throw new Error("current G1 missing");
  const { packet } = checkGateApproval(gate, "G1", g1.decision_ref);
  const selected = (ref: ArtifactRef) => parent.selectedArtifacts.some((x) => sameRef(x, ref));
  if (
    !selected(g1.packet_ref) ||
    !selected(g1.decision_ref) ||
    packet.presented.some((x) => !selected(x.ref))
  )
    throw new Error("G1 operands no longer selected by actual owner");
  if (packet.kind !== "approval" || !packet.effect_scope.kinds.includes("child_imagegen"))
    throw new Error("G1 has no image scope");
  const intent = validateAssetIntent(
    readSemantic({
      store: gate.store,
      project_id: gate.project_id,
      ref: asset.intent_ref,
      schema: AssetIntentV1Schema,
      schema_id: "penny.videogen-asset-intent.v1",
      limits: gate.limits,
    }),
    gate.limits
  );
  validateSkillSchema(
    ImageAssetCriteriaV1Schema,
    { allowed_change: intent.allowed_change, preserve_criteria: intent.preserve_criteria },
    "asset criteria"
  );
  if (
    intent.scope_status !== "proposed" ||
    !packet.presented.some((x) => x.role === "asset-intent" && sameRef(x.ref, asset.intent_ref)) ||
    !packet.effect_scope.subject_ids.includes(intent.asset_id)
  )
    throw new Error("asset intent is not in current G1");
  const approvedRefs = host.approved_intent_refs.filter(selected);
  const approved = approvedRefs
    .map((ref) => ({
      ref,
      value: validateAssetIntent(
        readSemantic({
          store: gate.store,
          project_id: gate.project_id,
          ref,
          schema: AssetIntentV1Schema,
          schema_id: "penny.videogen-asset-intent.v1",
          limits: gate.limits,
        }),
        gate.limits
      ),
    }))
    .filter((x) => x.value.asset_id === intent.asset_id && x.value.scope_status === "approved");
  const current = approved[0];
  if (
    approved.length !== 1 ||
    current === undefined ||
    current.value.scope_status !== "approved" ||
    current.value.gate_scope_ref === undefined ||
    !sameRef(current.value.gate_scope_ref, g1.decision_ref)
  )
    throw new Error("approved current asset intent missing");
  const { gate_scope_ref: _scope, scope_status: _status, ...body } = current.value;
  const { scope_status: _proposed, ...proposed } = intent;
  if (canonicalJson(body) !== canonicalJson(proposed))
    throw new Error("approved asset differs from G1 proposal");
  const calls = packet.presented
    .filter((x) => x.role === "image-asset-call")
    .map((x) => ({
      ref: x.ref,
      value: readSemantic({
        store: gate.store,
        project_id: gate.project_id,
        ref: x.ref,
        schema: ImageAssetCallV1Schema,
        schema_id: "penny.image-asset-call.v1",
        limits: gate.limits,
      }),
    }))
    .filter((x) => sameRef(x.value.asset.intent_ref, asset.intent_ref));
  const call = calls.find(
    (x) => x.value.image_run_id === runId && canonicalJson(x.value.asset) === canonicalJson(asset)
  );
  if (
    call === undefined ||
    call.value.profile_sha256 !== profileSha ||
    call.value.max_renders !== maxRenders ||
    new Set(calls.map((x) => x.value.image_run_id)).size !== calls.length ||
    new Set(calls.map((x) => x.value.asset.call_index)).size !== calls.length
  )
    throw new Error("unapproved image call/profile/revision allowance");
  const renders = calls.reduce((n, x) => n + BigInt(x.value.max_renders), 0n),
    cost = calls.reduce((n, x) => n + BigInt(x.value.cost_microcredits), 0n);
  const attempts = intent.estimated_meters.find((x) => x.meter === "attempts")?.reserved;
  const credits = intent.estimated_meters.find((x) => x.meter === "cost_microcredits")?.reserved;
  if (
    attempts === undefined ||
    credits === undefined ||
    renders > BigInt(attempts) ||
    renders > BigInt(intent.attempt_limit) ||
    cost > BigInt(credits) ||
    maxRenders < 1 ||
    call.value.cost_microcredits < 1
  )
    throw new Error("finite G1 call/spend envelope exceeded");
  if (intent.source !== `imagegen_${asset.input.kind}`)
    throw new Error("asset source role mismatch");
  const expected =
    asset.input.kind === "fresh"
      ? []
      : [
          asset.input.source_ref,
          ...(asset.input.area.kind === "mask" ? [asset.input.area.mask_ref] : []),
        ];
  if (canonicalJson(intent.input_refs) !== canonicalJson(expected))
    throw new Error("asset exact source/mask lineage mismatch");
  const rightsHost = { ...rights, now_utc: new Date().toISOString() };
  for (const ref of expected.length === 0 ? [intent.story_ref] : expected) {
    const row = rights.current_rights.find((x) => sameRef(x.subject_ref, ref));
    if (row === undefined) throw new Error("asset current rights missing");
    const binding = checkRights(rightsHost, ref, row.rights_ref, "preview");
    if (
      !binding.consent_refs.some((x) => sameRef(x, intent.consent_ref)) ||
      (!sameRef(row.rights_ref, intent.rights_ref) && sameRef(ref, expected[0] ?? intent.story_ref))
    )
      throw new Error("asset consent/rights mismatch");
  }
  if (asset.input.kind === "revision") {
    const source = readReferencePng(gate.store, asset.input.source_ref, "source");
    const mask =
      asset.input.area.kind === "mask"
        ? readReferencePng(gate.store, asset.input.area.mask_ref, "mask")
        : undefined;
    editMask(source, asset, mask);
  }
  return {
    intent,
    approved_intent_ref: current.ref,
    approval_ref: g1.decision_ref,
    call_ref: call.ref,
  };
}

/** Supplied admission is read-only custody, never a child or remote effect. */
export function admitSuppliedImage(input: {
  store: ArtifactStore;
  owner: VideogenOwnerSelection;
  source_ref: ArtifactRef;
  rights_ref: ArtifactRef;
  consent_ref: ArtifactRef;
  intent_ref: ArtifactRef;
}) {
  const { rights: rightsHost } = readVideogenOwnerSelection(input.owner);
  if (!(input.store instanceof ArtifactStore) || rightsHost.store !== input.store)
    throw new Error("supplied admission requires concrete same-project store");
  const intent = validateAssetIntent(
    readSemantic({
      store: input.store,
      project_id: rightsHost.project_id,
      ref: input.intent_ref,
      schema: AssetIntentV1Schema,
      schema_id: "penny.videogen-asset-intent.v1",
      limits: rightsHost.limits,
    }),
    rightsHost.limits
  );
  if (
    intent.source !== "supplied" ||
    intent.input_refs.length !== 1 ||
    !sameRef(intent.input_refs[0] ?? input.intent_ref, input.source_ref) ||
    !sameRef(intent.rights_ref, input.rights_ref) ||
    !sameRef(intent.consent_ref, input.consent_ref)
  )
    throw new Error("supplied asset intent mismatch");
  const rights = checkRights(
    { ...rightsHost, now_utc: new Date().toISOString() },
    input.source_ref,
    input.rights_ref,
    "source"
  );
  if (!rights.consent_refs.some((x) => sameRef(x, input.consent_ref)))
    throw new Error("supplied consent missing");
  readReferencePng(input.store, input.source_ref, "source");
  return validateSkillSchema(
    ImageAssetResultV1Schema,
    {
      schema_id: "penny.image-asset-result.v1",
      schema_version: 1,
      origin: "supplied",
      intent_ref: input.intent_ref,
      png_ref: input.source_ref,
      source_ref: input.source_ref,
      mask_ref: null,
      raw_ref: null,
      transformation_ref: null,
      upload_refs: [],
      render_receipt_ref: null,
      validity_ref: null,
      quality_ref: null,
    },
    "supplied image admission"
  );
}
