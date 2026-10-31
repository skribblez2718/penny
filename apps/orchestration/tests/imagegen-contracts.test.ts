import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef, StartRequest } from "../dist/contracts.js";
import { SqliteImagegenActivationController } from "../dist/imagegen/activation.js";
import { StaticImagegenExportRegistry } from "../dist/imagegen/export-registry.js";
import { buildImageSubmittedGraph } from "../dist/imagegen/graph-builder.js";
import { StaticImagegenProfileRegistry } from "../dist/imagegen/profile-registry.js";
import {
  beginImageReviewEpoch,
  completeImageReviewEpoch,
  createImageSlotLedger,
  imageSlotLedgerPositivelyComplete,
  transitionImageSlotGeneration,
} from "../dist/imagegen/slot-ledger.js";
import { SqliteImagegenStorageAdmission } from "../dist/imagegen/storage-admission.js";
import { IMAGEGEN_START_ADMISSION } from "../dist/imagegen/start-admission.js";
import {
  imagegenEffectiveSeed,
  imagegenProfileSha256,
  parseImagegenRequestIntent,
  validateImagegenProfile,
  validateImagegenRequest,
} from "../dist/skill-contracts/imagegen.js";
import {
  SYNTHETIC_NODE_POLICIES,
  syntheticInventory,
  syntheticProfile,
} from "./helpers/imagegen-fixtures.js";

const roots: string[] = [];
const resources: Array<{ close(): void }> = [];
afterEach(() => {
  for (const resource of resources.splice(0).reverse()) resource.close();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "penny-imagegen-test-"));
  roots.push(path);
  return path;
}

function ref(id: string, kind = "test", bytes = Buffer.from(id)): ArtifactRef {
  const digest = sha256(bytes);
  return {
    schema_version: 2,
    artifact_id: `art_${digest}`,
    kind,
    run_id: "run-imagegen-test",
    phase: "production",
    branch_id: "slot-1",
    operation_id: id,
    version: 1,
    producer: "test:imagegen",
    content_digest: digest,
    byte_length: bytes.byteLength,
    media_type: "application/json",
    content_schema: { schema_id: `penny.${kind}.v1`, schema_version: 1 },
    store_ref: `artifact://sha256/${digest}`,
  };
}

function providers(path: string) {
  const profile = syntheticProfile({ port: 8188 });
  const host = {
    profile,
    profiles: new StaticImagegenProfileRegistry({
      profiles: [profile],
      approved_profile_sha256_by_id: new Map([[profile.profile_id, profile.profile_sha256]]),
      node_class_policies: SYNTHETIC_NODE_POLICIES,
      default_profile_id: profile.profile_id,
    }),
    exports: new StaticImagegenExportRegistry([]),
    storage: new SqliteImagegenStorageAdmission({
      directory: path,
      ceiling_bytes: 64 * 1024 * 1024,
      warning_threshold_bytes: 48 * 1024 * 1024,
    }),
    activation: new SqliteImagegenActivationController({
      directory: join(path, "activation"),
      mode: "enabled",
    }),
  };
  resources.push(host.storage, host.activation);
  return host;
}

describe("closed imagegen contracts and injected policy", () => {
  it("defaults a strict request intent and rejects unknown request keys", () => {
    const intent = parseImagegenRequestIntent({
      goal: "Create a calm geometric scene",
      constraints: { schema_version: 1, count: 2 },
    });
    expect(intent.count).toBe(2);
    expect(intent.max_revision_rounds).toBe(1);
    expect(intent.requested_seed).toBeNull();
    expect(() =>
      parseImagegenRequestIntent({
        goal: "Create a calm geometric scene",
        constraints: { schema_version: 1, count: 2, surprise: true },
      })
    ).toThrow();
  });

  it("requires approved profile digests and denies dangerous graph input semantics", () => {
    const profile = syntheticProfile({ port: 8188 });
    expect(
      () =>
        new StaticImagegenProfileRegistry({
          profiles: [profile],
          approved_profile_sha256_by_id: new Map([[profile.profile_id, "0".repeat(64)]]),
          node_class_policies: SYNTHETIC_NODE_POLICIES,
        })
    ).toThrow("not exactly approved");
    expect(
      () =>
        new StaticImagegenProfileRegistry({
          profiles: [profile],
          approved_profile_sha256_by_id: new Map([[profile.profile_id, profile.profile_sha256]]),
          node_class_policies: SYNTHETIC_NODE_POLICIES.map((policy) =>
            policy.class_type === "OutputNode"
              ? {
                  ...policy,
                  inputs: policy.inputs.map((input) =>
                    input.input_name === "asset" ? { ...input, semantic: "data" as const } : input
                  ),
                }
              : policy
          ),
        })
    ).toThrow("safety policy drifted");
    const explicit = syntheticProfile({ port: 8189, profile_id: "explicit-profile" });
    const registry = new StaticImagegenProfileRegistry({
      profiles: [profile, explicit],
      approved_profile_sha256_by_id: new Map([
        [profile.profile_id, profile.profile_sha256],
        [explicit.profile_id, explicit.profile_sha256],
      ]),
      node_class_policies: SYNTHETIC_NODE_POLICIES,
      default_profile_id: profile.profile_id,
    });
    expect(registry.resolve().profile.profile_id).toBe(profile.profile_id);
    expect(registry.resolve(explicit.profile_id).profile.profile_id).toBe(explicit.profile_id);
    expect(() => registry.resolve("not-registered")).toThrow("not registered");
  });

  it("applies only the fallback rewrite declared by the approved profile", () => {
    const fallbackInventory = syntheticInventory("asset-fallback");
    const profile = syntheticProfile({
      port: 8188,
      fallback: {
        absent_model_id: "asset-primary",
        replacement_asset_id: "asset-fallback",
        fallback_inventory: fallbackInventory,
      },
    });
    const submitted = buildImageSubmittedGraph({
      profile_snapshot: {
        schema_id: "penny.imagegen-profile-snapshot.v1",
        schema_version: 1,
        profile,
        approved_profile_sha256: profile.profile_sha256,
        source_graph_sha256: profile.source_graph_sha256,
      },
      profile_snapshot_ref: ref("fallback-profile", "imagegen-profile-snapshot"),
      slot: 0,
      revision: 0,
      base_seed: 5,
      positive_prompt: "blue circle",
      negative_prompt: "noise",
      apply_fallback: true,
    });
    expect(submitted.fallback_disposition).toEqual({
      status: "applied",
      fallback_id: "synthetic-fallback",
    });
    expect(submitted.graph["4"]?.inputs["asset"]).toBe("asset-fallback");
    if (profile.fallback === null)
      throw new Error("synthetic fallback profile is missing fallback");
    const { profile_sha256: _profileSha256, ...body } = profile;
    const unsafeBody = {
      ...body,
      fallback: { ...profile.fallback, required_model_ids: ["different-asset"] },
    };
    expect(() =>
      validateImagegenProfile({
        ...unsafeBody,
        profile_sha256: imagegenProfileSha256(unsafeBody),
      })
    ).toThrow("not bound to the fallback inventory");
  });

  it("derives stable distinct per-slot seeds and checks slot bounds", () => {
    expect(imagegenEffectiveSeed(99, 1)).toBe(imagegenEffectiveSeed(99, 1));
    expect(imagegenEffectiveSeed(99, 1)).not.toBe(imagegenEffectiveSeed(99, 2));
    expect(() => imagegenEffectiveSeed(99, -1)).toThrow();
  });

  it("builds a deterministic allowlisted graph and rewrites every mutable field", () => {
    const profile = syntheticProfile({ port: 8188 });
    validateImagegenRequest({
      schema_id: "penny.imagegen-request.v1",
      schema_version: 1,
      goal: "Create a geometric image",
      count: 1,
      profile_id: profile.profile_id,
      dimensions: { width: 2, height: 2 },
      raw_prompt: "blue circle",
      seed: 42,
      max_revision_rounds: 1,
      export: null,
    });
    const snapshot = {
      schema_id: "penny.imagegen-profile-snapshot.v1" as const,
      schema_version: 1 as const,
      profile,
      approved_profile_sha256: profile.profile_sha256,
      source_graph_sha256: profile.source_graph_sha256,
    };
    const snapshotRef = ref("profile-snapshot", "imagegen-profile-snapshot");
    const first = buildImageSubmittedGraph({
      profile_snapshot: snapshot,
      profile_snapshot_ref: snapshotRef,
      slot: 1,
      revision: 0,
      base_seed: 42,
      positive_prompt: "blue circle",
      negative_prompt: "noise",
    });
    const second = buildImageSubmittedGraph({
      profile_snapshot: snapshot,
      profile_snapshot_ref: snapshotRef,
      slot: 1,
      revision: 0,
      base_seed: 42,
      positive_prompt: "blue circle",
      negative_prompt: "noise",
    });
    expect(second).toEqual(first);
    expect(first.graph["1"]?.inputs["positive"]).toBe("blue circle");
    expect(first.graph["3"]?.inputs["batch"]).toBe(1);
    expect(first.graph["4"]?.inputs["prefix"]).not.toBe("source-prefix");
    expect(first.graph["1"]?._meta).toBeUndefined();
  });
});

describe("imagegen admission, reservation, ledger, and export owners", () => {
  it("maps requested semantic repair rounds 0/1/2 to exact engine iteration ceilings", () => {
    for (const rounds of [0, 1, 2] as const) {
      const path = root();
      const host = providers(path);
      const request: StartRequest = {
        schema_version: 2,
        action: "start",
        identity: {
          schema_version: 2,
          run_id: `run-imagegen-rounds-${rounds}`,
          session_id: `session-imagegen-rounds-${rounds}`,
          playbook: "imagegen",
          engine_owner: "typescript",
        },
        goal: "Create a calm geometric scene",
        constraints: { schema_version: 1, count: 1, max_revision_rounds: rounds },
        project_root: path,
        trust_profile: "trusted-interactive",
      };
      const prepared = IMAGEGEN_START_ADMISSION.prepare(request, { imagegen: host });
      expect(prepared.constraints["max_iterations"]).toBe(rounds + 1);
    }
  });

  it("materializes exact typed start artifacts only after durable reservation", () => {
    const path = root();
    const host = providers(path);
    const artifacts = new ArtifactStore(join(path, "artifacts"));
    resources.push(artifacts);
    const request: StartRequest = {
      schema_version: 2,
      action: "start",
      identity: {
        schema_version: 2,
        run_id: "run-imagegen-test",
        session_id: "session-imagegen-test",
        playbook: "imagegen-playbook",
        engine_owner: "typescript",
      },
      goal: "Create a calm geometric scene",
      constraints: { schema_version: 1, count: 2, seed: 77 },
      project_root: path,
      trust_profile: "trusted-interactive",
    };
    const prepared = IMAGEGEN_START_ADMISSION.prepare(request, { imagegen: host });
    expect(prepared.constraints["accepted_job_ceiling"]).toBe(4);
    const refs = IMAGEGEN_START_ADMISSION.materialize(prepared, {
      run_id: request.identity.run_id,
      artifactStore: artifacts,
      imagegen: host,
    });
    expect(refs.map((item) => item.kind)).toEqual([
      "imagegen-request",
      "imagegen-profile-snapshot",
      "image-storage-reservation-receipt",
    ]);
    const materializedRequest = validateImagegenRequest(
      JSON.parse(artifacts.readById(refs[0]?.artifact_id ?? "").toString("utf8"))
    );
    expect(materializedRequest.seed).toBe(77);
    expect(materializedRequest.profile_id).toBe(host.profile.profile_id);
    expect(() => IMAGEGEN_START_ADMISSION.prepare(request, {})).toThrow();
    host.activation.close();
    host.storage.close();
  });

  it("persists reservation accounting across restart and rejects saturation and overcommit", () => {
    const directory = root();
    const first = new SqliteImagegenStorageAdmission({
      directory,
      ceiling_bytes: 100,
      warning_threshold_bytes: 80,
    });
    resources.push(first);
    const reservation = first.reserve({
      run_id: "run-storage",
      admission_sha256: "b".repeat(64),
      requested_bytes: 60,
      requested_seed: 123,
    });
    expect(reservation.base_seed).toBe(123);
    const contender = new SqliteImagegenStorageAdmission({
      directory,
      ceiling_bytes: 100,
      warning_threshold_bytes: 80,
      mode: "existing",
    });
    resources.push(contender);
    expect(() =>
      contender.reserve({
        run_id: "run-other",
        admission_sha256: "c".repeat(64),
        requested_bytes: 50,
        requested_seed: null,
      })
    ).toThrow("saturated");
    contender.close();
    const commit = first.commit({
      reservation_id: reservation.reservation_id,
      commit_key: "image-1",
      byte_length: 40,
    });
    expect(
      first.commit({
        reservation_id: reservation.reservation_id,
        commit_key: "image-1",
        byte_length: 40,
      })
    ).toEqual(commit);
    expect(() =>
      first.commit({
        reservation_id: reservation.reservation_id,
        commit_key: "image-2",
        byte_length: 30,
      })
    ).toThrow("exceeds");
    first.close();

    const recovered = new SqliteImagegenStorageAdmission({
      directory,
      ceiling_bytes: 100,
      warning_threshold_bytes: 80,
      mode: "existing",
    });
    resources.push(recovered);
    expect(recovered.reservation(reservation.reservation_id)?.reservation_id).toBe(
      reservation.reservation_id
    );
    const release = recovered.release(reservation.reservation_id);
    expect(release.committed_bytes_retained).toBe(40);
    expect(recovered.reservation(reservation.reservation_id)).toBeUndefined();
    recovered.close();
  });

  it("enforces legal slot transitions and complete review epochs", () => {
    let ledger = createImageSlotLedger({ run_id: "run-ledger", count: 1, base_seed: 123 });
    const graph = ref("graph-1", "image-submitted-graph");
    const image = ref("image-1", "generated-image");
    ledger = transitionImageSlotGeneration(ledger, {
      slot: 0,
      to: "prepared",
      submitted_graph_ref: graph,
    });
    ledger = transitionImageSlotGeneration(ledger, { slot: 0, to: "submitting" });
    ledger = transitionImageSlotGeneration(ledger, { slot: 0, to: "submitted" });
    ledger = transitionImageSlotGeneration(ledger, {
      slot: 0,
      to: "reviewable",
      image_ref: image,
      validation_receipt_ref: ref("validation-1", "image-validation-receipt"),
      operation_receipt_ref: ref("operation-1", "image-generation-operation-receipt"),
    });
    ledger = beginImageReviewEpoch({ ledger, current_images: [image] });
    ledger = completeImageReviewEpoch({
      ledger,
      vera_report_ref: ref("vera-review", "image-review-report"),
      carren_report_ref: ref("carren-review", "image-review-report"),
      failed_slots: [],
    });
    expect(imageSlotLedgerPositivelyComplete(ledger)).toBe(true);
    expect(ledger.review_epoch).toBe(1);
    expect(() => transitionImageSlotGeneration(ledger, { slot: 0, to: "submitted" })).toThrow(
      "illegal"
    );
  });

  it("enumerates terminal generation dispositions and re-reviews accepted revisions by epoch", () => {
    const terminalEvidence = (
      state:
        | "operational_failed"
        | "remote_failed"
        | "remote_unknown"
        | "downloaded_invalid"
        | "cancelled"
        | "skipped_after_prior_failure"
    ) => ({
      operation_receipt_ref: ref(`operation-${state}`, "image-generation-operation-receipt"),
      disposition_receipt_ref: ref(`disposition-${state}`, "host-operation-disposition-receipt"),
      reason_code: `${state}-reason`,
      lease_disposition:
        state === "remote_unknown" ? ("quarantined" as const) : ("released" as const),
      remote_may_continue: state === "remote_unknown",
      ...(state === "downloaded_invalid"
        ? { validation_receipt_ref: ref("validation-invalid", "image-validation-receipt") }
        : {}),
    });
    const graph = ref("enumerated-graph", "image-submitted-graph");
    const fromPrepared = transitionImageSlotGeneration(
      createImageSlotLedger({ run_id: "run-enumerated-prepared", count: 1, base_seed: 1 }),
      { slot: 0, to: "prepared", submitted_graph_ref: graph }
    );
    expect(
      transitionImageSlotGeneration(fromPrepared, {
        slot: 0,
        to: "cancelled",
        ...terminalEvidence("cancelled"),
      }).slots[0]?.state
    ).toBe("cancelled");
    const fromSubmitting = transitionImageSlotGeneration(fromPrepared, {
      slot: 0,
      to: "submitting",
    });
    for (const state of [
      "operational_failed",
      "remote_failed",
      "remote_unknown",
      "downloaded_invalid",
    ] as const) {
      expect(
        transitionImageSlotGeneration(fromSubmitting, {
          slot: 0,
          to: state,
          ...terminalEvidence(state),
        }).slots[0]?.state
      ).toBe(state);
    }
    const fromSubmitted = transitionImageSlotGeneration(fromSubmitting, {
      slot: 0,
      to: "submitted",
    });
    for (const state of ["remote_failed", "remote_unknown", "downloaded_invalid"] as const) {
      expect(
        transitionImageSlotGeneration(fromSubmitted, {
          slot: 0,
          to: state,
          ...terminalEvidence(state),
        }).slots[0]?.state
      ).toBe(state);
    }
    expect(
      transitionImageSlotGeneration(fromSubmitted, {
        slot: 0,
        to: "cancelled",
        ...terminalEvidence("cancelled"),
        lease_disposition: "quarantined",
        remote_may_continue: true,
      }).slots[0]
    ).toMatchObject({
      state: "cancelled",
      lease_disposition: "quarantined",
      remote_may_continue: true,
    });
    expect(() =>
      transitionImageSlotGeneration(fromSubmitted, { slot: 0, to: "remote_failed" })
    ).toThrow();
    expect(
      transitionImageSlotGeneration(
        createImageSlotLedger({ run_id: "run-enumerated-skipped", count: 1, base_seed: 1 }),
        {
          slot: 0,
          to: "skipped_after_prior_failure",
          ...terminalEvidence("skipped_after_prior_failure"),
        }
      ).slots[0]?.state
    ).toBe("skipped_after_prior_failure");

    const image = ref("epoch-image", "generated-image");
    let reviewLedger = transitionImageSlotGeneration(fromSubmitted, {
      slot: 0,
      to: "reviewable",
      image_ref: image,
      validation_receipt_ref: ref("epoch-validation", "image-validation-receipt"),
      operation_receipt_ref: ref("epoch-operation", "image-generation-operation-receipt"),
    });
    reviewLedger = beginImageReviewEpoch({ ledger: reviewLedger, current_images: [image] });
    reviewLedger = completeImageReviewEpoch({
      ledger: reviewLedger,
      vera_report_ref: ref("epoch-1-vera", "image-validity-report"),
      carren_report_ref: ref("epoch-1-carren", "image-quality-report"),
      failed_slots: [],
    });
    reviewLedger = beginImageReviewEpoch({ ledger: reviewLedger, current_images: [image] });
    reviewLedger = completeImageReviewEpoch({
      ledger: reviewLedger,
      vera_report_ref: ref("epoch-2-vera", "image-validity-report"),
      carren_report_ref: ref("epoch-2-carren", "image-quality-report"),
      failed_slots: [0],
    });
    expect(reviewLedger).toMatchObject({
      review_epoch: 2,
      slots: [{ state: "critic_failed", review_epoch: 2 }],
    });
    const repaired = transitionImageSlotGeneration(reviewLedger, {
      slot: 0,
      to: "prepared",
      submitted_graph_ref: ref("enumerated-graph-revision", "image-submitted-graph"),
    });
    expect(repaired.slots[0]).toMatchObject({ state: "prepared", revision: 1 });
  });

  it("exports a complete set only through an injected destination", () => {
    const path = root();
    const destination = join(path, "destination");
    mkdirSync(destination, { mode: 0o700 });
    const registry = new StaticImagegenExportRegistry([
      {
        destination_id: "approved-output",
        root: destination,
        max_files: 4,
        max_bytes: 1_024,
      },
    ]);
    const imageBytes = Buffer.from("exact image bytes");
    const manifestBytes = Buffer.from("exact manifest bytes");
    const imageRef = ref("source-image", "generated-image", imageBytes);
    const manifestRef = ref("source-manifest", "imagegen-manifest", manifestBytes);
    const payloads = new Map([
      [imageRef.artifact_id, imageBytes],
      [manifestRef.artifact_id, manifestBytes],
    ]);
    const input = {
      intent: { destination_id: "approved-output", directory_name: "nested" },
      files: [
        { filename: "output.bin", source_ref: imageRef },
        { filename: "manifest.json", source_ref: manifestRef },
      ],
      selected_filename: "output.bin",
      readArtifact: (source: ArtifactRef) => payloads.get(source.artifact_id) ?? new Uint8Array(),
    };
    const receipt = registry.export(input);
    expect(receipt.files).toHaveLength(2);
    expect(readFileSync(join(destination, "nested", "output.bin"))).toEqual(imageBytes);
    expect(() => registry.export(input)).toThrow();
    expect(() =>
      registry.resolve({ destination_id: "approved-output", directory_name: "../escape" })
    ).toThrow();
    expect(() =>
      registry.resolve({ destination_id: "not-registered", directory_name: "safe-directory" })
    ).toThrow("not registered");
  });
});
