import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { Type } from "typebox";

import {
  currentArtifactRef,
  type ArtifactStore,
  type ArtifactHostStore,
} from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import type { SqliteScaActivationOwner } from "./activation-owner.js";
import { SCA_P02_PHASE_PLAYBOOK_NAME, SCA_P02_PHASE_REGISTRATION } from "./p02-playbook.js";
import {
  createScaP02QualificationDefinitionFromSnapshot,
  requireScaP03AcceptedP02Qualification,
} from "./p03-p02-qualification-guard.js";
import { SCA_P02_IMPLEMENTATION_SOURCE_PATHS } from "./p02-qualification.js";
import type { ScaArtifactContractV1 } from "./qualification-gate.js";
import type { ScaActivationHostV1 } from "./qualification-activation.js";

const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const OperationalSummarySchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-p02-formal-collector-summary.v1"),
    schema_version: Type.Literal(1),
    tenant_id: Type.String({ minLength: 1 }),
    project_id: Type.String({ minLength: 1 }),
    run_id: Type.String({ minLength: 1 }),
    status: Type.Literal("candidate_boundary_passed"),
    aggregate_profile_sha256: Sha256Schema,
    deployment: Type.Object(
      {
        combined: Type.Object(
          {
            path: Type.String({ minLength: 1 }),
            sha256: Sha256Schema,
          },
          { additionalProperties: false }
        ),
      },
      { additionalProperties: true }
    ),
    authority_refs: Type.Object(
      {
        runtime_policy_ref: ArtifactRefSchema,
        isolation_evidence_ref: ArtifactRefSchema,
        host_attestation_ref: ArtifactRefSchema,
      },
      { additionalProperties: false }
    ),
    gate_ref: ArtifactRefSchema,
  },
  { additionalProperties: true }
);

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function exactJson(store: ArtifactHostStore, ref: ArtifactRef, label: string): unknown {
  const current = currentArtifactRef(ref, label);
  const stored = store.refById(current.artifact_id);
  if (stored === undefined || !same(stored, current))
    throw new Error(`${label} is absent or stale`);
  const bytes = store.readById(current.artifact_id);
  if (bytes.byteLength !== current.byte_length || sha256(bytes) !== current.content_digest)
    throw new Error(`${label} custody mismatch`);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error(`${label} is not canonical JSON`);
  return value;
}

export interface ScaP02CurrentHostBindingV1 {
  readonly source_manifest_sha256: string;
  readonly host_binding_sha256: string;
}

/** Recompute the exact current-tree binding used by the formal P02 qualification authority. */
export function measureScaP02CurrentHostBinding(input: {
  readonly project_root: string;
  readonly store: ArtifactStore;
  readonly operational_summary_ref: ArtifactRef;
  readonly artifact_reads?: ArtifactHostStore;
}): ScaP02CurrentHostBindingV1 {
  const projectRoot = path.resolve(input.project_root);
  const reads = input.artifact_reads ?? input.store;
  const operationalBytes = reads.readById(input.operational_summary_ref.artifact_id);
  const operationalSha256 = sha256(operationalBytes);
  const operational = validateContract(
    OperationalSummarySchema,
    exactJson(reads, input.operational_summary_ref, "P02 operational summary"),
    "P02 operational summary"
  );
  const sourceFiles = SCA_P02_IMPLEMENTATION_SOURCE_PATHS.map((relativePath) => {
    const absolute = path.resolve(projectRoot, relativePath);
    if (!absolute.startsWith(`${projectRoot}${path.sep}`))
      throw new Error("P02 implementation source path escaped the project root");
    const bytes = readFileSync(absolute);
    return { path: relativePath, sha256: sha256(bytes), byte_length: statSync(absolute).size };
  });
  const sourceManifestSha256 = sha256(canonicalJson(sourceFiles));
  const hostBindingInputs = {
    source_files: sourceFiles,
    source_manifest_sha256: sourceManifestSha256,
    operational_summary_sha256: operationalSha256,
    operational_summary_ref: currentArtifactRef(input.operational_summary_ref),
    operational_gate_ref: currentArtifactRef(operational.gate_ref),
    aggregate_profile_sha256: operational.aggregate_profile_sha256,
    deployment_sha256: operational.deployment.combined,
    runtime_policy_ref: currentArtifactRef(operational.authority_refs.runtime_policy_ref),
    isolation_evidence_ref: currentArtifactRef(operational.authority_refs.isolation_evidence_ref),
    host_attestation_ref: currentArtifactRef(operational.authority_refs.host_attestation_ref),
  };
  return {
    source_manifest_sha256: sourceManifestSha256,
    host_binding_sha256: sha256(canonicalJson(hostBindingInputs)),
  };
}

/**
 * Build the host-current activation snapshot for accepted P02. Sampling replays the complete V3
 * qualification closure and remeasures every qualified source file; stored labels cannot stand in
 * for current code or the independently authenticated issuance ledger.
 */
export function createScaP02ActivationHostV1(input: {
  readonly project_root: string;
  readonly store: ArtifactStore;
  /** Explicit inspection projection; concrete store still owns project identity. */
  readonly artifact_reads?: ArtifactHostStore;
  readonly partition_project_id: string;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly definition_ref: ArtifactRef;
  readonly gate_ref: ArtifactRef;
  readonly operational_summary_ref: ArtifactRef;
  readonly issuer_policy_id: string;
  readonly issuance_contract: ScaArtifactContractV1;
  readonly authority_contract: ScaArtifactContractV1;
  readonly revocation_generation: number;
  readonly owner: Pick<SqliteScaActivationOwner, "verifyIssuance">;
  readonly now?: () => Date;
}): ScaActivationHostV1 {
  const sample = () => {
    const snapshot = requireScaP03AcceptedP02Qualification({
      store: input.artifact_reads ?? input.store,
      definition_ref: input.definition_ref,
      gate_ref: input.gate_ref,
      tenant_id: input.tenant_id,
      project_id: input.project_id,
      accepted_p02_refs: [input.operational_summary_ref],
    });
    const measured = measureScaP02CurrentHostBinding({
      project_root: input.project_root,
      store: input.store,
      ...(input.artifact_reads === undefined ? {} : { artifact_reads: input.artifact_reads }),
      operational_summary_ref: input.operational_summary_ref,
    });
    if (
      snapshot.current_source_manifest_sha256 !== measured.source_manifest_sha256 ||
      snapshot.current_host_binding_sha256 !== measured.host_binding_sha256
    )
      throw new Error("P02 activation current-tree binding changed");
    return {
      store: input.store,
      ...(input.artifact_reads === undefined ? {} : { artifact_reads: input.artifact_reads }),
      partition_project_id: input.partition_project_id,
      tenant_id: input.tenant_id,
      project_id: input.project_id,
      phase_id: "SCA-P02",
      production_playbook_name: SCA_P02_PHASE_PLAYBOOK_NAME,
      registration: SCA_P02_PHASE_REGISTRATION,
      registration_class: "production" as const,
      qualified_subject_class: "production" as const,
      host_implementation_binding_sha256: measured.host_binding_sha256,
      qualification_definition: createScaP02QualificationDefinitionFromSnapshot(snapshot),
      issuer_policy_id: input.issuer_policy_id,
      issuance_contract: input.issuance_contract,
      authority_contract: input.authority_contract,
      revocation_generation: input.revocation_generation,
      now: (input.now ?? (() => new Date()))().toISOString(),
    };
  };
  return {
    sample,
    verifyIssuance: (verification) => input.owner.verifyIssuance(verification),
  };
}
