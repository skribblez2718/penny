import { assertImageAssetOwners, checkImageAsset, imageAssetMedia } from "./asset-authority.js";
import { backendMask } from "./reference-media.js";
import { DEFAULT_PNG_MEDIA_LIMITS, validateCanonicalPng } from "../png-media.js";
import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef, JsonValue } from "../contracts.js";
import type {
  PreparedStartV1,
  StartAdmissionArtifactHostV1,
  StartAdmissionReadOnlyHostV1,
  StartAdmissionV1,
} from "../playbooks/registry.js";
import {
  IMAGEGEN_MAX_RUN_STORAGE_BYTES,
  imagegenAcceptedJobCeiling,
  materializeImagegenRequest,
  parseImagegenRequestIntent,
  profilePermitsDimensions,
  validateImagegenProfileSnapshot,
  validateImagegenRequest,
  type ImagegenProfileSnapshotV1,
  type ImagegenRequestIntentV1,
} from "../skill-contracts/imagegen.js";
import {
  imagegenActivationRequestSha256,
  type ImagegenActivationAdmissionReceiptV1,
} from "./activation.js";
import type { ImagegenStartAdmissionProvidersV1, ResolvedImagegenProfileV1 } from "./types.js";

const FIXED_RUN_ARTIFACT_ALLOWANCE_BYTES = 1_048_576;

function providers(host: StartAdmissionReadOnlyHostV1): ImagegenStartAdmissionProvidersV1 {
  if (host.imagegen === undefined) {
    throw new Error("imagegen start admission requires injected host registries");
  }
  return host.imagegen;
}

function resolvedAdmission(input: {
  readonly request: PreparedStartV1["request"];
  readonly host: StartAdmissionReadOnlyHostV1;
}): {
  readonly intent: ImagegenRequestIntentV1;
  readonly resolved: ResolvedImagegenProfileV1;
  readonly reserved_bytes: number;
  readonly admission_sha256: string;
  readonly activation: ImagegenActivationAdmissionReceiptV1;
} {
  const host = providers(input.host);
  let intent = parseImagegenRequestIntent({
    goal: input.request.goal,
    constraints: input.request.constraints,
  });
  const resolved = host.profiles.resolve(intent.requested_profile_id ?? undefined);
  let referenceStorage = 0,
    canonicalOutputBound = 0;
  if (intent.asset !== undefined) {
    if (host.assets === undefined || intent.count !== 1 || intent.export !== null)
      throw new Error("asset calls require concrete G1 authority, one image and no export");
    assertImageAssetOwners(host.assets, input.host.artifactReader);
    checkImageAsset(
      host.assets,
      intent.asset,
      input.request.identity.run_id,
      resolved.profile.profile_sha256,
      intent.count * (1 + intent.max_revision_rounds)
    );
    if (intent.asset.input.kind === "revision") {
      const media = imageAssetMedia(host.assets, intent.asset),
        info = validateCanonicalPng(media.source),
        c = resolved.profile.revision_capability;
      if (
        c === undefined ||
        (intent.asset.input.area.kind === "whole") !== (c.method === "img2img")
      )
        throw new Error("revision method unavailable");
      if (
        media.source.byteLength > resolved.profile.limits.max_image_bytes ||
        (media.mask !== null && media.mask.byteLength > resolved.profile.limits.max_image_bytes) ||
        info.width * info.height > resolved.profile.limits.max_pixels
      )
        throw new Error("reference media exceeds profile byte/pixel limits");
      const dimensions = { width: info.width, height: info.height };
      const backend =
        media.mask === null
          ? null
          : c.backend_mask_polarity === null
            ? null
            : backendMask(media.mask, c.backend_mask_polarity);
      if (backend !== null && backend.byteLength > resolved.profile.limits.max_image_bytes)
        throw new Error("derived backend mask exceeds profile byte limit");
      // Two PNG lengths cover a cache envelope's base64 plus bounded framing. The white
      // edit mask and backend mask artifacts remain separate, even at identical pixels.
      referenceStorage =
        2 * media.source.byteLength +
        (media.mask?.byteLength ?? 0) +
        3 * (backend?.byteLength ?? 0);
      // Conservative fixed-encoder bound (two scanline lengths plus framing), independently
      // capped by shared canonical PNG admission. This is not a quality or resize rule.
      canonicalOutputBound = Math.min(
        DEFAULT_PNG_MEDIA_LIMITS.maxSourceBytes,
        2 * (info.width * info.height * 4 + info.height) + 1024
      );
      if (
        intent.dimensions !== null &&
        canonicalJson(intent.dimensions) !== canonicalJson(dimensions)
      )
        throw new Error("revision cannot resize source canvas");
      intent = { ...intent, dimensions };
    } else if (resolved.profile.revision_capability !== undefined)
      throw new Error("fresh call cannot use revision profile");
  } else if (resolved.profile.revision_capability !== undefined)
    throw new Error("revision requires separately typed consented asset ingress");
  // Fail-closed activation gate: runs before any effect, reservation, or artifact write. Disabled
  // denies every new start, canary consumes its one bound capability, and enabled admits ordinary
  // starts. Absence, drift, replay, and custody failures all deny here.
  const activation = host.activation.admit({
    run_id: input.request.identity.run_id,
    request_sha256: imagegenActivationRequestSha256({
      goal: input.request.goal,
      constraints: input.request.constraints,
    }),
    profile_sha256: resolved.profile.profile_sha256,
  });
  if (
    intent.dimensions !== null &&
    !profilePermitsDimensions(resolved.profile, intent.dimensions)
  ) {
    throw new Error("imagegen request dimensions are outside the approved profile policy");
  }
  const exportDestination = intent.export === null ? null : host.exports.resolve(intent.export);
  const acceptedJobs = intent.count * (1 + intent.max_revision_rounds);
  const perJob =
    resolved.profile.limits.max_image_bytes * (intent.asset?.input.kind === "revision" ? 4 : 1) +
    canonicalOutputBound +
    resolved.profile.limits.max_graph_bytes +
    resolved.profile.limits.max_request_json_bytes;
  const reservedBytes =
    referenceStorage +
    acceptedJobs * perJob +
    resolved.profile.limits.max_graph_bytes +
    FIXED_RUN_ARTIFACT_ALLOWANCE_BYTES;
  if (
    !Number.isSafeInteger(reservedBytes) ||
    reservedBytes > resolved.profile.limits.max_run_storage_bytes ||
    reservedBytes > IMAGEGEN_MAX_RUN_STORAGE_BYTES
  ) {
    throw new Error("imagegen request exceeds the approved worst-case run storage limit");
  }
  const admissionSha256 = sha256(
    canonicalJson({
      schema_version: 1,
      run_id: input.request.identity.run_id,
      intent,
      profile_sha256: resolved.profile.profile_sha256,
      backend_key_sha256: resolved.backend_key_sha256,
      export_destination: exportDestination,
      reserved_bytes: reservedBytes,
    })
  );
  return {
    intent,
    resolved,
    reserved_bytes: reservedBytes,
    admission_sha256: admissionSha256,
    activation,
  };
}

function persistExactJson(input: {
  readonly store: ArtifactHostStore;
  readonly metadata: Parameters<ArtifactHostStore["persist"]>[0]["metadata"];
  readonly value: unknown;
}): ArtifactRef {
  const content = canonicalJson(input.value);
  const existing = input.store.refFor(
    input.metadata.run_id,
    input.metadata.phase,
    input.metadata.branch_id,
    input.metadata.kind,
    input.metadata.operation_id,
    input.metadata.version
  );
  const ref = existing ?? input.store.persist({ metadata: input.metadata, content });
  if (
    input.store.readById(ref.artifact_id).toString("utf8") !== content ||
    canonicalJson(input.store.metadata(ref)) !== canonicalJson(input.metadata)
  ) {
    throw new Error("imagegen start artifact conflicts with exact persisted bytes");
  }
  input.store.select(ref);
  return ref;
}

function materializeInitialArtifacts(
  prepared: PreparedStartV1,
  host: StartAdmissionArtifactHostV1
): readonly ArtifactRef[] {
  const store = host.artifactStore;
  if (store === undefined) throw new Error("imagegen start admission requires an artifact store");
  const registries = providers(host);
  const admission = resolvedAdmission({ request: prepared.request, host });
  const reservation = registries.storage.reserve({
    run_id: host.run_id,
    admission_sha256: admission.admission_sha256,
    requested_bytes: admission.reserved_bytes,
    requested_seed: admission.intent.requested_seed,
  });
  const request = validateImagegenRequest(
    materializeImagegenRequest({
      intent: admission.intent,
      profile_id: admission.resolved.profile.profile_id,
      seed: reservation.base_seed,
    })
  );
  const snapshot = validateImagegenProfileSnapshot(admission.resolved.snapshot);
  const requestContent = canonicalJson(request);
  const snapshotContent = canonicalJson(snapshot);
  const reservationContent = canonicalJson(reservation);
  registries.storage.commit({
    reservation_id: reservation.reservation_id,
    commit_key: "start-artifacts",
    byte_length:
      Buffer.byteLength(requestContent, "utf8") +
      Buffer.byteLength(snapshotContent, "utf8") +
      Buffer.byteLength(reservationContent, "utf8"),
  });
  const snapshotRef = persistExactJson({
    store,
    metadata: {
      schema_version: 2,
      run_id: host.run_id,
      phase: "intake",
      branch_id: null,
      kind: "imagegen-profile-snapshot",
      operation_id: "imagegen-profile-snapshot",
      version: 1,
      producer: "host:imagegen-start-admission",
      media_type: "application/json",
      content_schema: {
        schema_id: "penny.imagegen-profile-snapshot.v1",
        schema_version: 1,
      },
      parent_ref: null,
      upstream_refs: [],
    },
    value: snapshot,
  });
  const requestRef = persistExactJson({
    store,
    metadata: {
      schema_version: 2,
      run_id: host.run_id,
      phase: "intake",
      branch_id: null,
      kind: "imagegen-request",
      operation_id: "imagegen-request",
      version: 1,
      producer: "host:imagegen-start-admission",
      media_type: "application/json",
      content_schema: { schema_id: "penny.imagegen-request.v1", schema_version: 1 },
      parent_ref: null,
      upstream_refs: [snapshotRef],
    },
    value: request,
  });
  const reservationRef = persistExactJson({
    store,
    metadata: {
      schema_version: 2,
      run_id: host.run_id,
      phase: "intake",
      branch_id: null,
      kind: "image-storage-reservation-receipt",
      operation_id: "imagegen-storage-reservation",
      version: 1,
      producer: "host:imagegen-storage-admission",
      media_type: "application/json",
      content_schema: {
        schema_id: "penny.image-storage-reservation-receipt.v1",
        schema_version: 1,
      },
      parent_ref: null,
      upstream_refs: [requestRef, snapshotRef],
    },
    value: reservation,
  });
  return [requestRef, snapshotRef, reservationRef];
}

/** Typed imagegen start boundary; production registration remains a later activation outcome. */
export const IMAGEGEN_START_ADMISSION: StartAdmissionV1 = {
  schema_id: "penny.imagegen-request.v1",
  schema_version: 1,
  prepare: (request, host) => {
    const admission = resolvedAdmission({ request, host });
    const runtimeConstraints: Readonly<Record<string, JsonValue>> = {
      schema_version: 1,
      max_iterations: admission.intent.max_revision_rounds + 1,
      accepted_job_ceiling: admission.intent.count * (1 + admission.intent.max_revision_rounds),
      max_proven_pre_acceptance_retries:
        admission.resolved.profile.limits.max_proven_pre_acceptance_retries,
    };
    return {
      schema_id: "penny.imagegen-request.v1",
      schema_version: 1,
      request,
      goal: admission.intent.goal,
      constraints: runtimeConstraints,
      ...(request.input_artifacts === undefined
        ? {}
        : { input_artifacts: request.input_artifacts }),
    };
  },
  materialize: materializeInitialArtifacts,
};

export function imagegenStartAdmissionSummary(input: {
  readonly request: ReturnType<typeof materializeImagegenRequest>;
  readonly profile: ImagegenProfileSnapshotV1;
}): Readonly<Record<string, JsonValue>> {
  const request = validateImagegenRequest(input.request);
  const snapshot = validateImagegenProfileSnapshot(input.profile);
  return {
    profile_id: request.profile_id,
    profile_sha256: snapshot.profile.profile_sha256,
    count: request.count,
    max_iterations: request.max_revision_rounds + 1,
    accepted_job_ceiling: imagegenAcceptedJobCeiling(request),
  };
}
