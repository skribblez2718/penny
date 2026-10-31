import { ArtifactStore } from "../artifact-store.js";
import { Checkpointer } from "../checkpointer.js";
import { canonicalJson } from "../canonical-json.js";
import type { ArtifactRef, JsonValue } from "../contracts.js";
import {
  assertImageAssetOwners,
  assertImageAssetScope,
  checkImageAsset,
} from "../imagegen/asset-authority.js";
import { ImageAssetResultV1Schema } from "../imagegen/reference-contracts.js";
import type { ImagegenStartAdmissionProvidersV1 } from "../imagegen/types.js";
import { evaluateImagegenCurrentReviewedProductDod } from "../playbooks/imagegen.js";
import { runtimeRegistrationSha256 } from "../playbooks/runtime-registration-digest.js";
import type { PlaybookRegistration } from "../playbooks/registry.js";
import { validateImagegenRequest } from "../skill-contracts/imagegen.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import {
  validateChildWorkflowRequest,
  type ChildWorkflowCallRecord,
  type ChildWorkflowInvocationDirective,
  type ChildWorkflowRequestV1,
} from "./contracts.js";
import { childWorkflowCallId, childWorkflowRunIdentity } from "./contracts.js";
import { validateImagegenChildPolicy, type ImagegenChildPolicyV1 } from "./imagegen-policy.js";

type ChildHost = {
  readonly artifacts: ArtifactStore;
  readonly checkpointer: Checkpointer;
  readonly providers: ImagegenStartAdmissionProvidersV1;
};
const childAuthorities = new WeakMap<
  object,
  { readonly source: ChildHost; readonly host: ChildHost }
>();
function childHost(value: unknown): ChildHost {
  const entry =
    typeof value === "object" && value !== null ? childAuthorities.get(value) : undefined;
  if (
    entry === undefined ||
    Object.getPrototypeOf(value) !== ImagegenChildRuntimeAuthority.prototype
  )
    throw new Error("imagegen child has no concrete construction-bound adapter");
  const { source, host } = entry;
  if (
    source.artifacts !== host.artifacts ||
    source.checkpointer !== host.checkpointer ||
    Object.keys(host.providers).some(
      (key) => Reflect.get(source.providers, key) !== Reflect.get(host.providers, key)
    )
  )
    throw new Error("imagegen child host ports changed");
  assertImageAssetOwners(host.providers.assets, host.artifacts, host.checkpointer);
  return host;
}
/** Construction-bound custody. Fixed module operations never dispatch through adapter methods. */
export class ImagegenChildRuntimeAuthority {
  constructor(source: ChildHost) {
    if (new.target !== ImagegenChildRuntimeAuthority)
      throw new Error("imagegen child has no concrete construction-bound adapter");
    const host = Object.freeze({ ...source, providers: Object.freeze({ ...source.providers }) });
    assertImageAssetOwners(host.providers.assets, host.artifacts, host.checkpointer);
    childAuthorities.set(this, { source, host });
    Object.freeze(this);
  }
  startParts(
    request: ChildWorkflowRequestV1,
    directive: ChildWorkflowInvocationDirective,
    policy: ImagegenChildPolicyV1,
    registration: PlaybookRegistration
  ) {
    return imagegenChildStartParts(this, request, directive, policy, registration);
  }
  output(record: ChildWorkflowCallRecord, output: ArtifactRef | null) {
    return imagegenChildOutput(this, record, output);
  }
}
Object.freeze(ImagegenChildRuntimeAuthority.prototype);
Object.freeze(ImagegenChildRuntimeAuthority);
export function assertImagegenChildAuthority(
  authority: unknown,
  artifacts: ArtifactStore,
  checkpointer: Checkpointer
): void {
  const host = childHost(authority);
  if (host.artifacts !== artifacts || host.checkpointer !== checkpointer)
    throw new Error("imagegen child belongs to different concrete owners");
}

export function imagegenChildStartParts(
  authority: unknown,
  request: ChildWorkflowRequestV1,
  directive: ChildWorkflowInvocationDirective,
  policyValue: ImagegenChildPolicyV1,
  registration: PlaybookRegistration
) {
  const host = childHost(authority);
  const policy = validateImagegenChildPolicy(policyValue);
  if (host.providers.activation.mode !== "enabled")
    throw new Error(
      "controlled imagegen children require an already enabled host activation; canary is standalone-only"
    );
  const native = validateImagegenRequest(request.provider_request);
  if (
    directive.schema_version !== 3 ||
    directive.child_name !== "imagegen" ||
    request.child_name !== "imagegen" ||
    request.provider_request_schema_id !== "penny.imagegen-request.v1" ||
    request.provider_request_schema_version !== 1 ||
    request.invocation_policy !== undefined ||
    native.asset === undefined ||
    native.count !== 1 ||
    native.export !== null ||
    !policy.parent_states.includes(directive.state_id) ||
    runtimeRegistrationSha256(registration) !== policy.provider_registration_sha256
  )
    throw new Error("imagegen child request, state, registration or native port is unauthorized");
  const assets = host.providers.assets;
  if (assets === undefined) throw new Error("imagegen child authority unavailable");
  assertImageAssetScope(
    assets,
    host.artifacts,
    host.checkpointer,
    directive.identity.run_id,
    directive.policy_binding.project_id
  );
  const callId = childWorkflowCallId({
    parent_run_id: directive.identity.run_id,
    parent_state_id: directive.state_id,
    call_key: directive.call_key,
  });
  const identity = childWorkflowRunIdentity({
    call_id: callId,
    parent: directive.identity,
    child_name: "imagegen",
  });
  const resolved = host.providers.profiles.resolve(native.profile_id);
  const bound = checkImageAsset(
    assets,
    native.asset,
    identity.run_id,
    resolved.profile.profile_sha256,
    native.count * (1 + native.max_revision_rounds)
  );
  if (!policy.asset_ids.includes(bound.intent.asset_id))
    throw new Error("imagegen asset is outside registered parent scope");
  const operands =
    native.asset.input.kind === "fresh"
      ? []
      : [
          native.asset.input.source_ref,
          ...(native.asset.input.area.kind === "mask" ? [native.asset.input.area.mask_ref] : []),
        ];
  const bindings = operands.map((ref, index) => ({
    slot: index === 0 ? "source_png" : "mask_png",
    ref,
  }));
  if (canonicalJson(directive.input_artifacts.artifacts) !== canonicalJson(bindings))
    throw new Error("imagegen child source/mask ports diverge from the exact native request");
  const constraints: Record<string, JsonValue> = {
    schema_version: 1,
    profile_id: native.profile_id,
    count: 1,
    seed: native.seed,
    max_revision_rounds: native.max_revision_rounds,
    asset: native.asset,
    ...(native.raw_prompt === null ? {} : { raw_prompt: native.raw_prompt }),
    ...(native.dimensions === null ? {} : { dimensions: native.dimensions }),
  };
  registration.start_admission?.prepare(
    {
      schema_version: 2,
      action: "start",
      identity,
      goal: native.goal,
      constraints,
      project_root: host.checkpointer.loadRun(directive.identity).projectRoot,
      trust_profile: host.checkpointer.loadRun(directive.identity).trustProfile,
    },
    { artifactReader: host.artifacts, imagegen: host.providers }
  );
  return { child_name: "imagegen", goal: native.goal, constraints };
}

/** Reuse the native positive completion predicate, current G1 and exact operation/critic lineage. */
export function imagegenChildOutput(
  authority: unknown,
  record: ChildWorkflowCallRecord,
  output: ArtifactRef | null
): readonly ArtifactRef[] {
  const host = childHost(authority);
  if (output === null) return [];
  const store = host.artifacts;
  const callRequest = validateChildWorkflowRequest(
    JSON.parse(store.read(record.request_ref).toString("utf8"))
  );
  const native = validateImagegenRequest(callRequest.provider_request);
  const assets = host.providers.assets;
  if (assets === undefined || native.asset === undefined)
    throw new Error("imagegen child lost concrete current authority");
  assertImageAssetScope(
    assets,
    store,
    host.checkpointer,
    record.parent_identity.run_id,
    record.policy_binding.project_id
  );
  const profile = host.providers.profiles.resolve(native.profile_id);
  const bound = checkImageAsset(
    assets,
    native.asset,
    record.child_identity.run_id,
    profile.profile.profile_sha256,
    native.count * (1 + native.max_revision_rounds)
  );
  const value = validateSkillSchema(
    ImageAssetResultV1Schema,
    JSON.parse(store.read(output).toString("utf8")),
    "ImageAssetResultV1"
  );
  const child = host.checkpointer.loadRun(record.child_identity);
  const envelope = host.checkpointer.completionAdmission(record.child_identity.run_id);
  if (
    child.terminalDirective?.action !== "complete" ||
    envelope === undefined ||
    output.run_id !== child.identity.run_id ||
    output.producer !== "host:imagegen-asset" ||
    !child.terminalDirective.artifacts.some(
      (ref) => canonicalJson(ref) === canonicalJson(output)
    ) ||
    value.origin !== native.asset.input.kind ||
    canonicalJson(value.intent_ref) !== canonicalJson(bound.approved_intent_ref) ||
    !evaluateImagegenCurrentReviewedProductDod({
      artifactReader: store,
      context: child,
      latestProduct: envelope.latest_product,
      originState: "admitting_product",
    }).passed
  )
    throw new Error("imagegen child output lacks current native reviewed-product admission");
  const refs = [
    value.png_ref,
    value.validity_ref,
    value.quality_ref,
    value.render_receipt_ref,
    value.source_ref,
    value.mask_ref,
    value.raw_ref,
    value.transformation_ref,
    ...value.upload_refs,
  ].filter((ref): ref is ArtifactRef => ref !== null);
  for (const ref of refs) store.read(ref);
  return refs;
}
