import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ArtifactHostStore, PersistArtifactInput } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { RunContext } from "../dist/context.js";
import type {
  ArtifactRef,
  CurrentArtifactRef,
  Directive,
  OutputArtifactMetadata,
} from "../dist/contracts.js";
import { SqliteImagegenActivationController } from "../dist/imagegen/activation.js";
import { StaticImagegenProfileRegistry } from "../dist/imagegen/profile-registry.js";
import type {
  ImagegenExportRegistry,
  ImagegenStartAdmissionProvidersV1,
  ImagegenStorageAdmission,
} from "../dist/imagegen/types.js";
import { encodeCanonicalPng } from "../dist/png-media.js";
import {
  IMAGEGEN_PLAYBOOK_REGISTRATION,
  ImagegenPlaybook,
  evaluateImagegenCurrentReviewedProductDod,
} from "../dist/playbooks/imagegen.js";
import { runtimeRegistrationSha256, skillContractSha256 } from "../dist/playbooks/registry.js";
import {
  validateImagegenProfileSnapshot,
  type ImagegenStorageReservationReceiptV1,
  type ImagegenStorageCommitReceiptV1,
  type ImagegenStorageReleaseReceiptV1,
} from "../dist/skill-contracts/imagegen.js";
import { SYNTHETIC_NODE_POLICIES, syntheticProfile } from "./helpers/imagegen-fixtures.js";

const RUN_ID = "run-imagegen-playbook";
const NOW = "2026-09-16T00:00:00.000Z";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");

function regularFiles(root: string): string[] {
  return readdirSync(root)
    .flatMap((entry) => {
      const candidate = path.join(root, entry);
      return statSync(candidate).isDirectory() ? regularFiles(candidate) : [candidate];
    })
    .sort();
}

class MemoryArtifactStore implements ArtifactHostStore {
  readonly bytes = new Map<string, Buffer>();
  readonly refs = new Map<string, ArtifactRef>();
  readonly metadataById = new Map<string, OutputArtifactMetadata>();

  persist(input: PersistArtifactInput): CurrentArtifactRef {
    const content =
      typeof input.content === "string"
        ? Buffer.from(input.content, "utf8")
        : Buffer.from(input.content);
    const digest = sha256(content);
    const identity = {
      branch_id: input.metadata.branch_id,
      kind: input.metadata.kind,
      operation_id: input.metadata.operation_id,
      phase: input.metadata.phase,
      run_id: input.metadata.run_id,
      version: input.metadata.version,
    };
    const ref: CurrentArtifactRef = {
      schema_version: 2,
      artifact_id: `art_${sha256(canonicalJson(identity))}`,
      run_id: input.metadata.run_id,
      phase: input.metadata.phase,
      branch_id: input.metadata.branch_id,
      kind: input.metadata.kind,
      operation_id: input.metadata.operation_id,
      version: input.metadata.version,
      producer: input.metadata.producer,
      media_type: input.metadata.media_type,
      ...(input.metadata.content_schema === undefined
        ? {}
        : { content_schema: input.metadata.content_schema }),
      byte_length: content.byteLength,
      content_digest: digest,
      store_ref: `artifact://sha256/${digest}`,
    };
    const prior = this.bytes.get(ref.artifact_id);
    if (prior !== undefined && !prior.equals(content)) {
      throw new Error(`artifact identity collision for ${ref.artifact_id}`);
    }
    this.bytes.set(ref.artifact_id, content);
    this.refs.set(ref.artifact_id, ref);
    this.metadataById.set(ref.artifact_id, input.metadata);
    return ref;
  }

  select(_ref: ArtifactRef): void {}

  metadata(ref: ArtifactRef): OutputArtifactMetadata {
    const metadata = this.metadataById.get(ref.artifact_id);
    if (metadata === undefined) throw new Error(`missing metadata for ${ref.artifact_id}`);
    return metadata;
  }

  refById(artifactId: string): ArtifactRef | undefined {
    return this.refs.get(artifactId);
  }

  readById(artifactId: string): Buffer {
    const bytes = this.bytes.get(artifactId);
    if (bytes === undefined) throw new Error(`missing artifact ${artifactId}`);
    return Buffer.from(bytes);
  }

  lastVersion(
    runId: string,
    phase: string,
    branchId: string | null,
    kind: string,
    operationId: string
  ): number {
    return [...this.refs.values()]
      .filter(
        (ref) =>
          ref.run_id === runId &&
          ref.phase === phase &&
          ref.branch_id === branchId &&
          ref.kind === kind &&
          ref.operation_id === operationId
      )
      .reduce((highest, ref) => Math.max(highest, ref.version), 0);
  }

  refFor(
    runId: string,
    phase: string,
    branchId: string | null,
    kind: string,
    operationId: string,
    version: number
  ): ArtifactRef | null {
    return (
      [...this.refs.values()].find(
        (ref) =>
          ref.run_id === runId &&
          ref.phase === phase &&
          ref.branch_id === branchId &&
          ref.kind === kind &&
          ref.operation_id === operationId &&
          ref.version === version
      ) ?? null
    );
  }
}

function metadata(input: {
  readonly phase: string;
  readonly kind: string;
  readonly operationId: string;
  readonly mediaType?: string;
  readonly schemaId?: string;
  readonly branchId?: string | null;
  readonly producer?: string;
  readonly upstream?: readonly ArtifactRef[];
}): OutputArtifactMetadata {
  return {
    schema_version: 2,
    run_id: RUN_ID,
    phase: input.phase,
    branch_id: input.branchId ?? null,
    kind: input.kind,
    operation_id: input.operationId,
    version: 1,
    producer: input.producer ?? "host:imagegen-provider-free-test",
    media_type: input.mediaType ?? "application/json",
    ...(input.schemaId === undefined
      ? {}
      : { content_schema: { schema_id: input.schemaId, schema_version: 1 } }),
    parent_ref: null,
    upstream_refs: [...(input.upstream ?? [])],
  };
}

function persistJson(
  store: MemoryArtifactStore,
  meta: OutputArtifactMetadata,
  value: unknown
): ArtifactRef {
  return store.persist({ metadata: meta, content: canonicalJson(value) });
}

function reservation(): ImagegenStorageReservationReceiptV1 {
  return {
    schema_id: "penny.image-storage-reservation-receipt.v1",
    schema_version: 1,
    reservation_id: "reservation-provider-free",
    run_id: RUN_ID,
    admission_sha256: "a".repeat(64),
    reserved_bytes: 1_048_576,
    base_seed: 42,
    partition_ceiling_bytes: 2_097_152,
    warning_threshold_bytes: 1_572_864,
    guaranteed_remaining_bytes: 1_048_576,
    state: "active",
    created_at: NOW,
  };
}

function providers(
  profileRegistry: StaticImagegenProfileRegistry
): ImagegenStartAdmissionProvidersV1 {
  let committed = 0;
  const storage: ImagegenStorageAdmission = {
    reserve: () => reservation(),
    commit: (input): ImagegenStorageCommitReceiptV1 => {
      committed += input.byte_length;
      return {
        schema_id: "penny.image-storage-commit-receipt.v1",
        schema_version: 1,
        commit_id: `commit-${sha256(input.commit_key).slice(0, 16)}`,
        reservation_id: input.reservation_id,
        commit_key: input.commit_key,
        committed_delta_bytes: input.byte_length,
        committed_total_bytes: committed,
        reserved_bytes: reservation().reserved_bytes,
        committed_at: NOW,
      };
    },
    release: (reservationId): ImagegenStorageReleaseReceiptV1 => ({
      schema_id: "penny.image-storage-release-receipt.v1",
      schema_version: 1,
      release_id: "release-provider-free",
      reservation_id: reservationId,
      committed_bytes_retained: committed,
      unused_bytes_released: reservation().reserved_bytes - committed,
      released_at: NOW,
    }),
    reservation: (reservationId) =>
      reservationId === reservation().reservation_id ? reservation() : undefined,
  };
  const exports: ImagegenExportRegistry = {
    resolve: () => {
      throw new Error("provider-free fixture has no export authority");
    },
    export: () => {
      throw new Error("provider-free fixture has no export authority");
    },
  };
  return {
    profiles: profileRegistry,
    storage,
    exports,
    activation: new SqliteImagegenActivationController({
      directory: mkdtempSync(path.join(tmpdir(), "penny-imagegen-playbook-activation-")),
      mode: "enabled",
    }),
  };
}

function addWorkerArtifact(
  context: RunContext,
  store: MemoryArtifactStore,
  directive: Extract<Directive, { action: "invoke_agent" }>,
  body: string
): ArtifactRef {
  const ref = store.persist({ metadata: directive.output_artifact, content: body });
  context.selectedArtifacts.push(ref);
  context.pendingDirective = null;
  return ref;
}

function fixture(): {
  readonly context: RunContext;
  readonly store: MemoryArtifactStore;
  readonly playbook: ImagegenPlaybook;
  readonly profileSha256: string;
} {
  const store = new MemoryArtifactStore();
  const profile = syntheticProfile({ port: 8188 });
  const profiles = new StaticImagegenProfileRegistry({
    profiles: [profile],
    approved_profile_sha256_by_id: new Map([[profile.profile_id, profile.profile_sha256]]),
    node_class_policies: SYNTHETIC_NODE_POLICIES,
    default_profile_id: profile.profile_id,
  });
  const snapshot = profiles.resolve(profile.profile_id).snapshot;
  const request = {
    schema_id: "penny.imagegen-request.v1",
    schema_version: 1,
    goal: "Create a calm wordless blue geometric image",
    count: 1,
    profile_id: profile.profile_id,
    dimensions: { width: 2, height: 2 },
    raw_prompt: "calm blue geometric forms",
    seed: 42,
    max_revision_rounds: 1,
    export: null,
  } as const;
  const requestRef = persistJson(
    store,
    metadata({
      phase: "admission",
      kind: "imagegen-request",
      operationId: "request",
      schemaId: "penny.imagegen-request.v1",
    }),
    request
  );
  const profileRef = persistJson(
    store,
    metadata({
      phase: "admission",
      kind: "imagegen-profile-snapshot",
      operationId: "profile",
      schemaId: "penny.imagegen-profile-snapshot.v1",
    }),
    snapshot
  );
  const reservationRef = persistJson(
    store,
    metadata({
      phase: "admission",
      kind: "image-storage-reservation-receipt",
      operationId: "reservation",
      schemaId: "penny.image-storage-reservation-receipt.v1",
    }),
    reservation()
  );
  const context = RunContext.create({
    identity: {
      schema_version: 2,
      run_id: RUN_ID,
      session_id: "session-imagegen-playbook",
      playbook: "imagegen",
      engine_owner: "typescript",
    },
    goal: request.goal,
    constraints: { schema_version: 1, max_iterations: 2 },
    projectRoot: "/provider-free-project-root",
    trustProfile: "hardened-untrusted",
    maxSteps: 32,
    registrationContractBinding: {
      schema_version: 1,
      registration_name: "imagegen",
      contract_sha256: skillContractSha256(IMAGEGEN_PLAYBOOK_REGISTRATION.contract),
      registration_sha256: runtimeRegistrationSha256(IMAGEGEN_PLAYBOOK_REGISTRATION),
    },
    initialArtifacts: [requestRef, profileRef, reservationRef],
  });
  return {
    context,
    store,
    playbook: new ImagegenPlaybook(store, store, providers(profiles)),
    profileSha256: profile.profile_sha256,
  };
}

function invokeAgent(directive: Directive): Extract<Directive, { action: "invoke_agent" }> {
  if (directive.action !== "invoke_agent")
    throw new Error(`expected invoke_agent, got ${directive.action}`);
  return directive;
}

function invokeHost(directive: Directive): Extract<Directive, { action: "invoke_host_operation" }> {
  if (directive.action !== "invoke_host_operation") {
    throw new Error(`expected invoke_host_operation, got ${directive.action}`);
  }
  return directive;
}

function parallel(directive: Directive): Extract<Directive, { action: "invoke_agents_parallel" }> {
  if (directive.action !== "invoke_agents_parallel") {
    throw new Error(`expected invoke_agents_parallel, got ${directive.action}`);
  }
  return directive;
}

function completeReadiness(input: {
  readonly context: RunContext;
  readonly store: MemoryArtifactStore;
  readonly playbook: ImagegenPlaybook;
  readonly directive: Extract<Directive, { action: "invoke_host_operation" }>;
}): Extract<Directive, { action: "invoke_agent" }> {
  const profileRef = input.directive.input_artifacts.artifacts.find(
    (artifact) => artifact.slot === "profile_snapshot"
  )?.ref;
  if (profileRef === undefined) throw new Error("readiness profile snapshot is absent");
  const snapshot = validateImagegenProfileSnapshot(
    JSON.parse(input.store.readById(profileRef.artifact_id).toString("utf8"))
  );
  const readinessRef = persistJson(
    input.store,
    metadata({
      phase: "preflight",
      kind: "imagegen-readiness-receipt",
      operationId: "readiness-receipt",
      schemaId: "penny.imagegen-readiness-receipt.v1",
      upstream: [profileRef],
    }),
    {
      schema_id: "penny.imagegen-readiness-receipt.v1",
      schema_version: 1,
      status: "ready",
      profile_id: snapshot.profile.profile_id,
      profile_sha256: snapshot.profile.profile_sha256,
      profile_snapshot_ref: profileRef,
      inventory_sha256: "f".repeat(64),
      fallback_disposition: { status: "not_applied" },
    }
  );
  const disposition = {
    outcome: "completed",
    remote_disposition: "proven_terminal",
    lease_disposition: "released",
    retryable: false,
    reason_code: null,
  } as const;
  const resultRef = persistJson(
    input.store,
    metadata({
      phase: "preflight",
      kind: "host-operation-result",
      operationId: "readiness-platform-result",
      schemaId: "penny.host-operation-result.v1",
    }),
    {
      schema_version: 1,
      operation_record_id: "readiness-operation-record",
      identity: input.context.identity,
      state_id: "preflight",
      attempt: input.directive.attempt,
      operation_id: input.directive.operation_id,
      operation_kind: input.directive.operation_kind,
      registration_sha256: input.directive.registration_sha256,
      request_sha256: input.directive.request_sha256,
      lease: null,
      disposition,
      operation_result_ref: readinessRef,
      output_artifacts: [],
    }
  );
  input.context.selectedArtifacts.push(readinessRef, resultRef);
  input.context.pendingDirective = null;
  return invokeAgent(input.playbook.dispatch(input.context));
}

describe("provider-free imagegen production playbook", () => {
  it("completes the registered playbook/host-operation boundary with one exact dual-reviewed PNG", () => {
    const { context, store, playbook, profileSha256 } = fixture();
    const readiness = invokeHost(playbook.initialize(context));
    expect(readiness.operation_kind).toBe("imagegen.comfyui-readiness.v1");
    const framing = completeReadiness({ context, store, playbook, directive: readiness });
    expect(framing.agent).toBe("annie");
    addWorkerArtifact(context, store, framing, "Annie provider-free frame");

    const composing = invokeAgent(
      playbook.acceptSummary(
        context,
        {
          complete: true,
          needs_clarification: false,
          clarifying_questions: [],
          frame: {
            schema_id: "penny.image-frame.v1",
            schema_version: 1,
            brief: "A calm wordless geometric composition in blue.",
            hard_requirements: ["wordless", "blue geometric forms"],
            material_ambiguities: [],
          },
        },
        "CERTAIN"
      )
    );
    expect(composing.agent).toBe("synthia");
    addWorkerArtifact(context, store, composing, "Synthia provider-free prompt plan");

    const operation = invokeHost(
      playbook.acceptSummary(
        context,
        {
          complete: true,
          needs_clarification: false,
          clarifying_questions: [],
          prompt_plan: {
            schema_id: "penny.image-prompt-plan.v1",
            schema_version: 1,
            positive_prompt: "calm blue geometric forms",
            negative_prompt: "text, letters, words, captions, watermark, typography",
            raw_prompt_preserved: true,
            strategy_delta: null,
          },
        },
        "CERTAIN"
      )
    );
    expect(operation.operation_kind).toBe("imagegen.comfyui-generate.v1");
    expect(operation.policy_binding.backend_key_sha256).toMatch(/^[a-f0-9]{64}$/u);
    const submittedGraphRef = operation.input_artifacts.artifacts.find(
      (artifact) => artifact.slot === "submitted_graph"
    )?.ref;
    if (submittedGraphRef === undefined) throw new Error("submitted graph ref is absent");

    const png = encodeCanonicalPng({
      width: 2,
      height: 2,
      rgba: Buffer.from([0, 80, 180, 255, 0, 100, 200, 255, 20, 110, 210, 255, 40, 120, 220, 255]),
    });
    const imageRef = store.persist({
      metadata: metadata({
        phase: "generating_candidate",
        kind: "generated-image",
        operationId: "slot-0-image",
        mediaType: "image/png",
        upstream: [submittedGraphRef],
      }),
      content: png,
    });
    const validation = {
      schema_id: "penny.image-validation-receipt.v1",
      schema_version: 1,
      slot: 0,
      revision: 0,
      status: "valid",
      response_status: 200,
      response_media_type: "image/png",
      raw_sha256: sha256(png),
      raw_byte_length: png.byteLength,
      canonical_sha256: sha256(png),
      canonical_byte_length: png.byteLength,
      dimensions: { width: 2, height: 2 },
      decoder: "penny.png-media.v1",
      reason_code: null,
    } as const;
    const validationRef = persistJson(
      store,
      metadata({
        phase: "generating_candidate",
        kind: "image-validation-receipt",
        operationId: "slot-0-validation",
        schemaId: "penny.image-validation-receipt.v1",
        upstream: [submittedGraphRef],
      }),
      validation
    );
    const operationReceiptRef = persistJson(
      store,
      metadata({
        phase: "generating_candidate",
        kind: "image-generation-operation-receipt",
        operationId: "slot-0-operation",
        schemaId: "penny.image-generation-operation-receipt.v1",
        upstream: [submittedGraphRef, validationRef, imageRef],
      }),
      {
        schema_id: "penny.image-generation-operation-receipt.v1",
        schema_version: 1,
        run_id: RUN_ID,
        reservation_id: reservation().reservation_id,
        profile_sha256: profileSha256,
        submitted_graph_ref: submittedGraphRef,
        slot: 0,
        revision: 0,
        effective_seed: 42,
        status: "persisted",
        prompt_id_sha256: "b".repeat(64),
        poll_count: 1,
        validation,
        storage_commit_id: "storage-commit-image",
      }
    );
    const disposition = {
      outcome: "completed",
      remote_disposition: "proven_terminal",
      lease_disposition: "released",
      retryable: false,
      reason_code: null,
    } as const;
    const hostReceiptRef = persistJson(
      store,
      metadata({
        phase: "generating_candidate",
        kind: "host-operation-receipt",
        operationId: "slot-0-host-receipt",
        schemaId: "penny.host-operation-receipt.v1",
      }),
      { schema_version: 1, disposition }
    );
    const platformResultRef = persistJson(
      store,
      metadata({
        phase: "generating_candidate",
        kind: "host-operation-result",
        operationId: "slot-0-platform-result",
        schemaId: "penny.host-operation-result.v1",
      }),
      {
        schema_version: 1,
        operation_record_id: "operation-record-provider-free",
        identity: context.identity,
        state_id: "generating_candidate",
        attempt: operation.attempt,
        operation_id: operation.operation_id,
        operation_kind: operation.operation_kind,
        registration_sha256: operation.registration_sha256,
        request_sha256: operation.request_sha256,
        lease: null,
        disposition,
        operation_result_ref: operationReceiptRef,
        output_artifacts: [validationRef, imageRef],
      }
    );
    context.selectedArtifacts.push(
      validationRef,
      imageRef,
      operationReceiptRef,
      hostReceiptRef,
      platformResultRef
    );
    context.pendingDirective = null;

    const critics = parallel(playbook.dispatch(context));
    expect(critics.branches.map((branch) => branch.agent).sort()).toEqual(["carren", "vera"]);
    const candidate = {
      slot: 0,
      revision: 0,
      image_artifact_id: imageRef.artifact_id,
      image_sha256: imageRef.content_digest,
    };
    const validity = {
      schema_id: "penny.image-validity-report.v1",
      schema_version: 1,
      review_epoch: 1,
      candidates: [{ candidate, approved: true, finding_ids: [] }],
      findings: [],
    };
    const quality = {
      schema_id: "penny.image-quality-report.v1",
      schema_version: 1,
      review_epoch: 1,
      candidates: [{ candidate, approved: true, finding_ids: [] }],
      findings: [],
      ranking: [candidate],
    };
    const validityFailure = {
      ...validity,
      candidates: [{ candidate, approved: false, finding_ids: ["vera-hard-failure"] }],
      findings: [
        {
          finding_id: "vera-hard-failure",
          slot: 0,
          revision: 0,
          code: "hard-requirement-failed",
          detail: "The current image violates a hard visual requirement.",
          blocking: true,
        },
      ],
    };
    const qualityFailure = {
      ...quality,
      candidates: [{ candidate, approved: false, finding_ids: ["carren-quality-failure"] }],
      findings: [
        {
          finding_id: "carren-quality-failure",
          slot: 0,
          revision: 0,
          code: "aesthetic-quality-failed",
          detail: "The current image does not meet the requested aesthetic quality.",
          blocking: true,
        },
      ],
    };
    expect(
      playbook.evaluateRepair(context, "critiquing_candidates", {
        validity_report: validityFailure,
        quality_report: qualityFailure,
      })?.kind
    ).toBe("validation_gap");
    expect(
      playbook.evaluateRepair(context, "critiquing_candidates", {
        validity_report: validity,
        quality_report: qualityFailure,
      })?.kind
    ).toBe("product_gap");
    const vera = critics.branches.find((branch) => branch.branch_id === "vera");
    const carren = critics.branches.find((branch) => branch.branch_id === "carren");
    if (vera === undefined || carren === undefined) throw new Error("critic branches are absent");
    const veraRef = store.persist({ metadata: vera.output_artifact, content: "Vera approved" });
    const carrenRef = store.persist({
      metadata: carren.output_artifact,
      content: "Carren approved",
    });
    context.pendingBranches = [
      {
        branch_id: "vera",
        agent: "vera",
        attempt: vera.attempt,
        completed: true,
        confidence: "CERTAIN",
        result: null,
        artifact: veraRef,
      },
      {
        branch_id: "carren",
        agent: "carren",
        attempt: carren.attempt,
        completed: true,
        confidence: "CERTAIN",
        result: null,
        artifact: carrenRef,
      },
    ];
    context.selectedArtifacts.push(veraRef, carrenRef);
    context.pendingDirective = null;

    const terminal = playbook.acceptSummary(
      context,
      { validity_report: validity, quality_report: quality },
      "CERTAIN"
    );
    expect(terminal.action).toBe("complete");
    if (terminal.action !== "complete") throw new Error("imagegen did not complete");
    expect(terminal.met).toBe(true);
    expect(terminal.result.output_artifact_ref).toEqual(imageRef);
    expect(terminal.result.selected_image_ref).toEqual(imageRef);
    expect(terminal.artifacts.filter((ref) => ref.kind === "generated-image")).toEqual([imageRef]);
    expect(terminal.artifacts.map((ref) => ref.kind)).toEqual(
      expect.arrayContaining([
        "image-selection-receipt",
        "image-slot-ledger",
        "imagegen-manifest",
        "image-product-envelope",
        "image-storage-release-receipt",
      ])
    );
    expect(context.playbookData.request).toMatchObject({ raw_prompt: "calm blue geometric forms" });
    const completionEvidence = {
      selector: "terminal_artifact" as const,
      schema_id: "penny.generated-image.v1",
      product_schema_version: 1,
      product_id: imageRef.artifact_id,
      sha256: imageRef.content_digest,
    };
    expect(
      evaluateImagegenCurrentReviewedProductDod({
        artifactReader: store,
        context,
        latestProduct: completionEvidence,
        originState: "admitting_product",
      })
    ).toMatchObject({ passed: true });
    expect(
      evaluateImagegenCurrentReviewedProductDod({
        artifactReader: store,
        context,
        latestProduct: { ...completionEvidence, sha256: "0".repeat(64) },
        originState: "admitting_product",
      })
    ).toEqual({ passed: false, evidence_refs: [] });
  });

  it("fails closed before generation when a raw prompt is rewritten or wordless policy is absent", () => {
    const { context, store, playbook } = fixture();
    const readiness = invokeHost(playbook.initialize(context));
    const framing = completeReadiness({ context, store, playbook, directive: readiness });
    addWorkerArtifact(context, store, framing, "frame");
    const composing = invokeAgent(
      playbook.acceptSummary(
        context,
        {
          complete: true,
          needs_clarification: false,
          clarifying_questions: [],
          frame: {
            schema_id: "penny.image-frame.v1",
            schema_version: 1,
            brief: "A calm wordless geometric composition in blue.",
            hard_requirements: ["wordless"],
            material_ambiguities: [],
          },
        },
        "CERTAIN"
      )
    );
    addWorkerArtifact(context, store, composing, "bad prompt");
    expect(() =>
      playbook.acceptSummary(
        context,
        {
          complete: true,
          needs_clarification: false,
          clarifying_questions: [],
          prompt_plan: {
            schema_id: "penny.image-prompt-plan.v1",
            schema_version: 1,
            positive_prompt: "rewritten prompt",
            negative_prompt: "blurry",
            raw_prompt_preserved: false,
            strategy_delta: null,
          },
        },
        "CERTAIN"
      )
    ).toThrow("raw positive prompt");
    expect(
      context.selectedArtifacts.some((ref) => ref.kind === "image-generation-operation-request")
    ).toBe(false);
  });

  it("keeps tracked activation surfaces free of operator paths, concrete model files, and fixed ports", () => {
    const files = [
      path.join(PACKAGE_ROOT, "src", "playbooks", "imagegen.ts"),
      path.join(REPO_ROOT, "docs", "agents", "architecture", "image-generation.md"),
      path.join(REPO_ROOT, "docs", "humans", "architecture", "image-generation.md"),
      ...regularFiles(path.join(REPO_ROOT, ".pi", "skills", "imagegen")),
    ];
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(source).not.toMatch(/\/(?:home|Users)\/[A-Za-z0-9._-]+\//u);
    expect(source).not.toContain(":\\Users\\");
    expect(source).not.toContain(":\\Documents\\");
    expect(source).not.toMatch(/\.(?:safetensors|ckpt)\b/iu);
    expect(source).not.toMatch(/"port"\s*:\s*\d+/u);
    expect(source).not.toContain("operator-project");
  });

  it("registers exact image-capability critics, bounded repair, hidden ingress, and no concrete private values", () => {
    const registration = IMAGEGEN_PLAYBOOK_REGISTRATION;
    const vera = registration.worker.phases.get("critiquing_candidates_vera");
    const carren = registration.worker.phases.get("critiquing_candidates_carren");
    expect(vera).toMatchObject({ agent: "vera", requires_image_input: true });
    expect(carren).toMatchObject({ agent: "carren", requires_image_input: true });
    expect(registration.contract.repair_routing.routes).toEqual([
      expect.objectContaining({
        origin_state: "critiquing_candidates",
        feedback_kind: "validation_gap",
        repair: { action: "transition", target_state: "adjusting_prompt" },
      }),
      expect.objectContaining({
        origin_state: "critiquing_candidates",
        feedback_kind: "product_gap",
        repair: { action: "transition", target_state: "adjusting_prompt" },
      }),
    ]);
    expect(registration.ingress).toBe("skill");
    expect(
      readFileSync(path.join(REPO_ROOT, ".pi", "skills", "imagegen", "SKILL.md"), "utf8")
    ).toContain("disable-model-invocation: true");
    expect(canonicalJson(registration)).not.toMatch(
      /\/home\/|[A-Za-z]:\\|\.safetensors|\/api\/prompt|operator-project/iu
    );
  });
});
