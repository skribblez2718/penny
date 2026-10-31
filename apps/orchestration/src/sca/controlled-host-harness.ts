import { lstatSync } from "node:fs";
import path from "node:path";

import { ArtifactStore, currentArtifactRef, previewArtifactRef } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { Checkpointer } from "../checkpointer.js";
import type { ArtifactRef } from "../contracts.js";
import type { OrchestrationEngine } from "../engine.js";
import type { HostOperationAdapterV1 } from "../host-operations/contracts.js";
import { HostOperationLeaseAuthority } from "../host-operations/lease-authority.js";
import {
  HOST_OPERATION_FAULT_POINTS,
  HostOperationRuntimeOwner,
  HostOperationSimulatedCrashError,
  type HostOperationFaultPointV1,
} from "../host-operations/owner.js";
import { FileHostOperationResultCache } from "../host-operations/result-cache.js";
import { runtimeRegistrationSha256, type PlaybookRegistration } from "../playbooks/registry.js";
import { ProjectCatalog } from "../state/catalog.js";
import { pennyStatePaths, projectStatePaths } from "../state/paths.js";
import type { ScaQualificationEvidenceClass } from "./qualification-gate-contracts.js";

/** A controlled host is a rehearsal, not an attestor. Its observations cannot qualify a live phase. */
export type ControlledEvidenceClass = Extract<
  ScaQualificationEvidenceClass,
  "synthetic" | "fixture"
>;

export interface ControlledHostBindings {
  readonly implementation_revision: string;
  readonly implementation_ref: ArtifactRef;
  readonly implementation_provenance: {
    readonly parent_ref: ArtifactRef | null;
    readonly upstream_refs: readonly ArtifactRef[];
  };
  /** Host-sampled runtime registration, not a digest claimed by an artifact. */
  readonly runtime_registration_sha256: string;
  readonly corpus_ref: ArtifactRef;
  readonly corpus_provenance: {
    readonly parent_ref: ArtifactRef | null;
    readonly upstream_refs: readonly ArtifactRef[];
  };
}

export interface ControlledObservation {
  readonly schema_version: 1;
  readonly evidence_class: ControlledEvidenceClass;
  readonly qualification_disposition: "not_live_qualified";
  readonly implementation_revision: string;
  readonly implementation_ref: ArtifactRef;
  readonly implementation_assurance_scope: "declaration_only";
  readonly runtime_registration_sha256: string;
  readonly corpus_ref: ArtifactRef;
  readonly observed_ref: ArtifactRef;
  readonly observed_sha256: string;
  readonly observed_at: string;
}

export interface ControlledHostLimits {
  readonly max_unique_artifact_bytes: number;
  readonly max_observations: number;
}

/** Reject a rehearsal even when the embedded observation claims success. Live admission remains
 * the production phase gate's responsibility, with its independently verified authority closure.
 */
export function requireLiveQualifiedObservation(observation: ControlledObservation): never {
  throw new Error(
    `controlled-host ${observation.evidence_class} evidence cannot satisfy live-qualified`
  );
}

export class ControlledClock {
  constructor(private instant: number) {
    this.assertTime(instant);
  }

  now = (): number => this.instant;

  advance(milliseconds: number): number {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error("controlled clock advance must be a nonnegative safe integer");
    }
    this.assertTime(this.instant + milliseconds);
    this.instant += milliseconds;
    return this.instant;
  }

  private assertTime(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
      throw new Error("controlled clock instant is invalid");
    }
  }
}

/** An armed fault fires exactly once. The next owner must be constructed from reopened stores. */
export class ControlledFaultDriver {
  private armed: HostOperationFaultPointV1 | null = null;
  private operationKind: string | null = null;

  arm(point: HostOperationFaultPointV1, operationKind: string): void {
    if (!HOST_OPERATION_FAULT_POINTS.includes(point) || !operationKind || this.armed !== null) {
      throw new Error("controlled fault must be a single registered host boundary");
    }
    this.armed = point;
    this.operationKind = operationKind;
  }

  fault = (point: HostOperationFaultPointV1, operationKind: string): void => {
    if (point === this.armed && operationKind === this.operationKind) {
      this.armed = null;
      this.operationKind = null;
      throw new HostOperationSimulatedCrashError(point);
    }
  };
}

function checkLimits(limits: ControlledHostLimits): void {
  if (
    !Number.isSafeInteger(limits.max_unique_artifact_bytes) ||
    limits.max_unique_artifact_bytes < 1 ||
    limits.max_unique_artifact_bytes > 256 * 1_048_576 ||
    !Number.isSafeInteger(limits.max_observations) ||
    limits.max_observations < 1 ||
    limits.max_observations > 1_024
  ) {
    throw new Error("controlled-host limits must be finite and positive");
  }
}

/** Existing stores and authority only. No playbook registration, remote adapter, or qualification
 * receipt is created by provisioning this harness. Caller owns the temporary root and its cleanup.
 */
export class ScaControlledHostHarness implements Disposable {
  readonly projectId: string;
  readonly artifacts: ArtifactStore;
  readonly checkpointer: Checkpointer;
  readonly leases: HostOperationLeaseAuthority;
  readonly cache: FileHostOperationResultCache;
  readonly clock: ControlledClock;
  readonly faults = new ControlledFaultDriver();
  private readonly seen = new Map<string, string>();
  private chargedBytes = 0;
  private observations = 0;

  private constructor(
    readonly stateRoot: string,
    projectId: string,
    artifacts: ArtifactStore,
    checkpointer: Checkpointer,
    leases: HostOperationLeaseAuthority,
    cache: FileHostOperationResultCache,
    clock: ControlledClock,
    private readonly limits: ControlledHostLimits
  ) {
    this.projectId = projectId;
    this.artifacts = artifacts;
    this.checkpointer = checkpointer;
    this.leases = leases;
    this.cache = cache;
    this.clock = clock;
  }

  static async provision(input: {
    readonly temporary_root: string;
    readonly project_root: string;
    readonly now_ms: number;
    readonly limits: ControlledHostLimits;
  }): Promise<ScaControlledHostHarness> {
    checkLimits(input.limits);
    if (!path.isAbsolute(input.temporary_root) || !path.isAbsolute(input.project_root)) {
      throw new Error("controlled-host roots must be caller-provided absolute paths");
    }
    const clock = new ControlledClock(input.now_ms);
    const stateRoot = path.join(input.temporary_root, "state");
    if (lstatSync(stateRoot, { throwIfNoEntry: false }) !== undefined) {
      throw new Error("controlled-host state root must be fresh for provisioning");
    }
    using catalog = new ProjectCatalog(stateRoot, { create: true });
    const projectId = catalog.registerProject(input.project_root).projectId;
    const paths = projectStatePaths(pennyStatePaths(stateRoot), projectId);
    const artifacts = ArtifactStore.provision(paths.artifacts.root, { projectId });
    try {
      const checkpointer = Checkpointer.provision(paths.orchestration.database, undefined, {
        projectId,
      });
      try {
        const leases = new HostOperationLeaseAuthority(stateRoot);
        try {
          const cache = await FileHostOperationResultCache.provision(
            path.join(paths.root, "host-operation-result-cache")
          );
          return new ScaControlledHostHarness(
            stateRoot,
            projectId,
            artifacts,
            checkpointer,
            leases,
            cache,
            clock,
            input.limits
          );
        } catch (error) {
          leases.close();
          throw error;
        }
      } catch (error) {
        checkpointer.close();
        throw error;
      }
    } catch (error) {
      artifacts.close();
      throw error;
    }
  }

  /** Reopen the actual journal, manifest, global lease and cache; no in-memory recovery shortcut. */
  static async reopen(input: {
    readonly temporary_root: string;
    readonly project_root: string;
    readonly now_ms: number;
    readonly limits: ControlledHostLimits;
  }): Promise<ScaControlledHostHarness> {
    checkLimits(input.limits);
    if (!path.isAbsolute(input.temporary_root) || !path.isAbsolute(input.project_root)) {
      throw new Error("controlled-host roots must be caller-provided absolute paths");
    }
    const clock = new ControlledClock(input.now_ms);
    const stateRoot = path.join(input.temporary_root, "state");
    using catalog = new ProjectCatalog(stateRoot, { create: false });
    const binding = catalog.lookupProject(input.project_root);
    if (binding === undefined) throw new Error("controlled-host project binding is absent");
    const projectId = binding.projectId;
    const paths = projectStatePaths(pennyStatePaths(stateRoot), projectId);
    const artifacts = ArtifactStore.openExisting(paths.artifacts.root, { projectId });
    try {
      const checkpointer = Checkpointer.openExisting(paths.orchestration.database, undefined, {
        projectId,
      });
      try {
        const leases = new HostOperationLeaseAuthority(stateRoot);
        try {
          const cacheRoot = path.join(paths.root, "host-operation-result-cache");
          if (!lstatSync(cacheRoot).isDirectory())
            throw new Error("controlled-host cache is absent");
          const cache = await FileHostOperationResultCache.openExisting(cacheRoot);
          return new ScaControlledHostHarness(
            stateRoot,
            projectId,
            artifacts,
            checkpointer,
            leases,
            cache,
            clock,
            input.limits
          );
        } catch (error) {
          leases.close();
          throw error;
        }
      } catch (error) {
        checkpointer.close();
        throw error;
      }
    } catch (error) {
      artifacts.close();
      throw error;
    }
  }

  owner(adapters: ReadonlyMap<string, HostOperationAdapterV1>): HostOperationRuntimeOwner {
    return new HostOperationRuntimeOwner({
      projectId: this.projectId,
      checkpointer: this.checkpointer,
      artifacts: this.artifacts,
      leaseAuthority: this.leases,
      resultCache: this.cache,
      adapters,
      now: this.clock.now,
      fault: this.faults.fault,
    });
  }

  /** Exact stored ref, parent/upstream metadata and bytes, charged once per unique ID. */
  readExact(
    refValue: ArtifactRef,
    expected: {
      readonly parent_ref: ArtifactRef | null;
      readonly upstream_refs: readonly ArtifactRef[];
    }
  ): Buffer {
    const ref = currentArtifactRef(refValue);
    const signature = canonicalJson(ref);
    const prior = this.seen.get(ref.artifact_id);
    if (prior !== undefined && prior !== signature) throw new Error("artifact ID metadata changed");
    if (
      prior === undefined &&
      ref.byte_length > this.limits.max_unique_artifact_bytes - this.chargedBytes
    ) {
      throw new Error("controlled-host unique artifact byte budget exceeded");
    }
    const stored = this.artifacts.refById(ref.artifact_id);
    if (stored === undefined || canonicalJson(stored) !== signature) {
      throw new Error("controlled-host exact artifact ref is absent or divergent");
    }
    const metadata = this.artifacts.metadata(ref);
    if (
      canonicalJson(metadata.parent_ref) !== canonicalJson(expected.parent_ref) ||
      canonicalJson(metadata.upstream_refs) !== canonicalJson(expected.upstream_refs)
    ) {
      throw new Error("controlled-host artifact provenance diverges");
    }
    const bytes = this.artifacts.readById(ref.artifact_id);
    if (
      bytes.byteLength !== ref.byte_length ||
      sha256(bytes) !== ref.content_digest ||
      canonicalJson(previewArtifactRef({ metadata, content: bytes })) !== signature
    ) {
      throw new Error("controlled-host artifact digest or metadata diverges");
    }
    if (prior === undefined) {
      this.seen.set(ref.artifact_id, signature);
      this.chargedBytes += ref.byte_length;
    }
    return bytes;
  }

  /** Capture only rehearsal-class evidence; the recorded ref is itself independently readable. */
  capture(input: {
    readonly evidence_class: ControlledEvidenceClass;
    readonly bindings: ControlledHostBindings;
    readonly observed_ref: ArtifactRef;
    readonly observed_provenance: {
      readonly parent_ref: ArtifactRef | null;
      readonly upstream_refs: readonly ArtifactRef[];
    };
    readonly registration: PlaybookRegistration;
    readonly run_id: string;
    readonly operation_id: string;
  }): { readonly ref: ArtifactRef; readonly observation: ControlledObservation } {
    if (input.evidence_class !== "synthetic" && input.evidence_class !== "fixture") {
      throw new Error("controlled-host evidence class is not a rehearsal class");
    }
    const opaque = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
    if (
      input.bindings.runtime_registration_sha256 !==
        runtimeRegistrationSha256(input.registration) ||
      !opaque.test(input.bindings.implementation_revision) ||
      !opaque.test(input.run_id) ||
      !opaque.test(input.operation_id)
    ) {
      throw new Error("controlled-host implementation/runtime binding is invalid");
    }
    if (this.observations >= this.limits.max_observations) {
      throw new Error("controlled-host observation budget exceeded");
    }
    this.readExact(input.bindings.implementation_ref, input.bindings.implementation_provenance);
    this.readExact(input.bindings.corpus_ref, input.bindings.corpus_provenance);
    const observed = this.readExact(input.observed_ref, input.observed_provenance);
    const observation: ControlledObservation = {
      schema_version: 1,
      evidence_class: input.evidence_class,
      qualification_disposition: "not_live_qualified",
      implementation_revision: input.bindings.implementation_revision,
      implementation_ref: input.bindings.implementation_ref,
      implementation_assurance_scope: "declaration_only",
      runtime_registration_sha256: input.bindings.runtime_registration_sha256,
      corpus_ref: input.bindings.corpus_ref,
      observed_ref: input.observed_ref,
      observed_sha256: sha256(observed),
      observed_at: new Date(this.clock.now()).toISOString(),
    };
    const upstreamRefs = [
      input.bindings.implementation_ref,
      input.bindings.corpus_ref,
      input.observed_ref,
    ].sort((a, b) => Buffer.compare(Buffer.from(a.artifact_id), Buffer.from(b.artifact_id)));
    if (new Set(upstreamRefs.map((ref) => ref.artifact_id)).size !== upstreamRefs.length) {
      throw new Error("controlled-host implementation, corpus and observation must be distinct");
    }
    const metadata = {
      schema_version: 2 as const,
      run_id: input.run_id,
      phase: "SCA-controlled-host",
      branch_id: null,
      kind: "sca-controlled-observation",
      operation_id: input.operation_id,
      version: 1,
      producer: "host:sca-controlled-harness",
      media_type: "application/json",
      content_schema: { schema_id: "penny.sca-controlled-observation.v1", schema_version: 1 },
      parent_ref: null,
      upstream_refs: upstreamRefs,
    };
    const content = canonicalJson(observation);
    if (Buffer.byteLength(content) > this.limits.max_unique_artifact_bytes - this.chargedBytes) {
      throw new Error("controlled-host observation byte budget exceeded");
    }
    const ref = this.artifacts.persist({ metadata, content });
    if (
      !this.readExact(ref, { parent_ref: null, upstream_refs: upstreamRefs }).equals(
        Buffer.from(content)
      )
    ) {
      throw new Error("controlled-host observation exact readback failed");
    }
    this.observations += 1;
    return { ref, observation };
  }

  /** The engine is caller-owned and must carry its own registered production contract. */
  async dispatch(
    engine: OrchestrationEngine,
    directive: Parameters<HostOperationRuntimeOwner["dispatch"]>[1],
    adapters: ReadonlyMap<string, HostOperationAdapterV1>
  ): Promise<Awaited<ReturnType<HostOperationRuntimeOwner["dispatch"]>>> {
    if (engine.registration === undefined) throw new Error("controlled-host engine is unbound");
    return this.owner(adapters).dispatch(engine, directive);
  }

  close(): void {
    this.leases.close();
    this.checkpointer.close();
    this.artifacts.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
