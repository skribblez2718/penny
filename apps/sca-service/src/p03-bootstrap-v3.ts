import type { ArtifactHostStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ArtifactRef } from "../../orchestration/dist/contracts.js";
import {
  SCA_P03_BOOTSTRAP_RECORD_V3_SCHEMA,
  validateScaP03AttemptWitnessV1,
  validateScaP03CleanupEvidenceV2,
  validateScaP03IsolationEvidenceV2,
  validateScaP03BootstrapQualificationRecordV3,
  type ScaP03BootstrapQualificationRecordV3,
} from "../../orchestration/dist/sca/p03-bootstrap-contracts.js";
import { validateScaP03QualificationFixtureContentV1 } from "../../orchestration/dist/sca/p03-contracts.js";
import {
  checkArtifact,
  exactP03BootstrapObservations,
  P03_BOOTSTRAP_ROLES,
  readP03BootstrapBytes,
  readP03BootstrapInputs,
  readP03ProductionInputs,
  type ScaP03BootstrapArtifactReaderV1,
  type ScaP03FrozenBootstrapBindingsV3,
  type ScaP03FrozenProductionBindingsV1,
} from "./p03-bootstrap.js";
import {
  censusScaP03WorkspaceV1,
  measureScaP03BuildClosureV3,
  validateScaP03ConfinementProjectionV3,
  type ScaP03BootstrapHostProbeV1,
} from "./p03-bootstrap-host.js";
import { ScaP03HostWitnessSinkV1 } from "./p03-bootstrap-witness.js";
import { ScaP03WorkspaceRegistryV1 } from "./p03-bootstrap-workspaces.js";
import type { ScaP03DockerCandidateV1 } from "./p03-docker-runtime.js";
import type { ScaP03RuntimeQualificationOutputV1 } from "./p03-operations.js";

export type ScaP03MeasuredBootstrapV3 = Readonly<{
  witness_bytes: Uint8Array;
  output: ScaP03RuntimeQualificationOutputV1 | null;
  disposition: "completed" | "failed" | "cancelled";
}>;
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const frozenKeys = [
  "fixture_corpus_ref",
  "source_oracle_ref",
  "source_oracle_validation_ref",
  "source_oracle_review_ref",
  "parser_identity_sha256",
  "baseline_query_set_ref",
  "qualification_profile_ref",
  "runtime_policy_ref",
  "implementation_identity_ref",
  "runtime_identity_ref",
  "fixture_content_refs",
  "query_script_refs",
  "query_plan_refs",
  "runtime_package_refs",
  "implementation_source_refs",
  "runtime_id",
  "isolation_id",
  "runtime_tree_sha256",
  "joern_version",
  "max_num_def",
  "implementation_identity_sha256",
  "deployment_identity_sha256",
  "profile_id",
  "profile_sha256",
  "release_id",
  "release_sha256",
] satisfies readonly (keyof ScaP03FrozenBootstrapBindingsV3)[];
function assertFrozenBindings(bindings: ScaP03FrozenBootstrapBindingsV3): void {
  if (!same(Object.keys(bindings).sort(), [...frozenKeys].sort()))
    throw new Error("p03_bootstrap_frozen_bindings_invalid");
}
function candidateDigest(run_id: string, b: ScaP03FrozenBootstrapBindingsV3): string {
  return sha256(
    canonicalJson({
      run_id,
      runtime_id: b.runtime_id,
      isolation_id: b.isolation_id,
      implementation_sha256: b.implementation_identity_sha256,
      deployment_sha256: b.deployment_identity_sha256,
      profile_sha256: b.profile_sha256,
      implementation_source_refs: b.implementation_source_refs,
    })
  );
}
function fixture(store: ScaP03BootstrapArtifactReaderV1, ref: ArtifactRef) {
  const bytes = readP03BootstrapBytes(store, ref);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error("p03_bootstrap_fixture_noncanonical");
  const f = validateScaP03QualificationFixtureContentV1(value);
  const decoded = Buffer.from(f.content_base64, "base64");
  if (sha256(decoded) !== f.content_sha256) throw new Error("p03_bootstrap_fixture_drift");
  return {
    ref,
    fixture_id: f.fixture_id,
    language: f.language,
    path: f.path,
    content_sha256: f.content_sha256,
    bytes: decoded,
  };
}
function custody(
  store: ScaP03BootstrapArtifactReaderV1,
  ref: ArtifactRef,
  run_id: string,
  kind: string,
  schema_id: string,
  producer: string,
  upstream: readonly ArtifactRef[]
): void {
  checkArtifact(store, ref, {
    run_id,
    kind,
    schema_id,
    schema_version: Number(schema_id.slice(-1)),
    producer,
    parent: null,
    upstream,
  });
}
/** Preflight is frozen-only. The sink must be handed to the real candidate factory before execution. */
export async function measureScaP03BootstrapCandidateV3(input: {
  run_id: string;
  bindings: ScaP03FrozenBootstrapBindingsV3;
  store: ScaP03BootstrapArtifactReaderV1;
  probe: ScaP03BootstrapHostProbeV1;
  implementation_refs: readonly ArtifactRef[];
  workspace_registry: ScaP03WorkspaceRegistryV1;
  candidate: (witness: ScaP03HostWitnessSinkV1) => Promise<ScaP03DockerCandidateV1>;
  signal: AbortSignal;
}): Promise<ScaP03MeasuredBootstrapV3> {
  const { bindings: b, store, probe } = input;
  if (!(input.workspace_registry instanceof ScaP03WorkspaceRegistryV1))
    throw new Error("p03_bootstrap_registry_required");
  assertFrozenBindings(b);
  const { corpus, release, profile, receipt } = readP03BootstrapInputs(store, b, input.run_id);
  const fixtures = b.fixture_content_refs.map((ref) => fixture(store, ref));
  if (!same(input.implementation_refs, b.implementation_source_refs))
    throw new Error("p03_bootstrap_implementation_refs_unbound");
  const implementationClosure = await measureScaP03BuildClosureV3(
    store,
    probe,
    b.implementation_source_refs
  );
  const packageClosure = await measureScaP03BuildClosureV3(
    store,
    probe,
    [...b.runtime_package_refs].sort((a, c) => a.artifact_id.localeCompare(c.artifact_id))
  );
  const identity = await probe.measureIdentity();
  if (
    identity.runtime_id !== b.runtime_id ||
    identity.isolation_id !== b.isolation_id ||
    identity.implementation_sha256 !== b.implementation_identity_sha256 ||
    identity.deployment_sha256 !== b.deployment_identity_sha256 ||
    identity.runtime_package_sha256 !== packageClosure ||
    identity.image_id !== `sha256:${b.runtime_tree_sha256}` ||
    identity.joern_version !== b.joern_version ||
    implementationClosure.length !== 64
  )
    throw new Error("p03_bootstrap_preflight_identity_drift");
  const sink = new ScaP03HostWitnessSinkV1(
    {
      run_id: input.run_id,
      candidate_sha256: candidateDigest(input.run_id, b),
      identity,
    },
    input.workspace_registry
  );
  try {
    input.signal.throwIfAborted();
    const candidate = await input.candidate(sink);
    if (
      candidate.runtime_id !== b.runtime_id ||
      candidate.isolation_id !== b.isolation_id ||
      candidate.runtime_tree_sha256 !== b.runtime_tree_sha256 ||
      candidate.implementation_identity_sha256 !== b.implementation_identity_sha256 ||
      candidate.deployment_identity_sha256 !== b.deployment_identity_sha256 ||
      candidate.isolation_profile_sha256 !== b.profile_sha256 ||
      candidate.measured_joern_version !== b.joern_version ||
      candidate.max_num_def !== b.max_num_def
    )
      throw new Error("p03_bootstrap_candidate_identity_mismatch");
    const output = await candidate.qualify({
      fixtures,
      expected_cases: corpus.expected_cases,
      source_oracle_validation_ref: b.source_oracle_validation_ref,
      source_oracle_validation_receipt: receipt,
      query_release: release,
      fidelity_requirements: profile.fidelity_requirements,
      signal: input.signal,
    });
    if (
      !exactP03BootstrapObservations(
        corpus,
        release,
        fixtures,
        output,
        b.source_oracle_validation_ref
      )
    )
      return { output, disposition: "failed", witness_bytes: sink.finalize("failed") };
    input.signal.throwIfAborted();
    if (
      (await probe.workspaceIdentityDigest(sink.attempt_id)) !== sink.workspaceDigest() ||
      (await probe.containerCensus(sink.executionNames())).length !== 0 ||
      !same(await probe.measureIdentity(), identity) ||
      (await measureScaP03BuildClosureV3(store, probe, b.implementation_source_refs)) !==
        implementationClosure ||
      (await measureScaP03BuildClosureV3(
        store,
        probe,
        [...b.runtime_package_refs].sort((a, c) => a.artifact_id.localeCompare(c.artifact_id))
      )) !== packageClosure
    )
      throw new Error("p03_bootstrap_post_measurement_drift");
    await censusScaP03WorkspaceV1(await probe.workspacePaths(sink.attempt_id));
    return { output, disposition: "completed", witness_bytes: sink.finalize("completed") };
  } catch {
    return {
      output: null,
      disposition: input.signal.aborted ? "cancelled" : "failed",
      witness_bytes: sink.finalize(input.signal.aborted ? "cancelled" : "failed"),
    };
  }
}

/** Production measurement revalidates accepted P01 roots before construction and after execution. */
export async function measureScaP03ProductionCandidateV1(input: {
  run_id: string;
  production_bindings: ScaP03FrozenProductionBindingsV1;
  store: ArtifactHostStore & ScaP03BootstrapArtifactReaderV1;
  probe: ScaP03BootstrapHostProbeV1;
  implementation_refs: readonly ArtifactRef[];
  workspace_registry: ScaP03WorkspaceRegistryV1;
  candidate: (witness: ScaP03HostWitnessSinkV1) => Promise<ScaP03DockerCandidateV1>;
  signal: AbortSignal;
}): Promise<ScaP03MeasuredBootstrapV3> {
  const { production_bindings: production, ...rest } = input;
  readP03ProductionInputs(input.store, production);
  const measured = await measureScaP03BootstrapCandidateV3({
    ...rest,
    bindings: production.frozen,
  });
  readP03ProductionInputs(input.store, production);
  return measured;
}

/** Only exact persisted host evidence can close a successful attempt; no callback decisions. */
export async function finalizeScaP03BootstrapRecordV3(input: {
  run_id: string;
  bindings: ScaP03FrozenBootstrapBindingsV3;
  measured: ScaP03MeasuredBootstrapV3;
  attempt_ref: ArtifactRef;
  cleanup_ref: ArtifactRef;
  isolation_ref: ArtifactRef;
  implementation_refs: readonly ArtifactRef[];
  store: ScaP03BootstrapArtifactReaderV1;
  probe: ScaP03BootstrapHostProbeV1;
}): Promise<ScaP03BootstrapQualificationRecordV3> {
  const { bindings: b, store, probe } = input;
  assertFrozenBindings(b);
  if (!same(input.implementation_refs, b.implementation_source_refs))
    throw new Error("p03_bootstrap_implementation_refs_unbound");
  const { corpus, release } = readP03BootstrapInputs(store, b, input.run_id);
  const attempt = validateScaP03AttemptWitnessV1(readP03BootstrapBytes(store, input.attempt_ref));
  const cleanup = validateScaP03CleanupEvidenceV2(readP03BootstrapBytes(store, input.cleanup_ref));
  const isolation = validateScaP03IsolationEvidenceV2(
    readP03BootstrapBytes(store, input.isolation_ref)
  );
  custody(
    store,
    input.attempt_ref,
    input.run_id,
    "sca-p03-attempt-witness",
    attempt.schema_id,
    P03_BOOTSTRAP_ROLES.evaluator,
    [
      b.runtime_policy_ref,
      b.implementation_identity_ref,
      b.runtime_identity_ref,
      ...b.implementation_source_refs,
    ]
  );
  custody(
    store,
    input.cleanup_ref,
    input.run_id,
    "sca-p03-cleanup-evidence",
    cleanup.schema_id,
    P03_BOOTSTRAP_ROLES.cleanup,
    [input.attempt_ref, b.runtime_policy_ref]
  );
  custody(
    store,
    input.isolation_ref,
    input.run_id,
    "sca-p03-isolation-evidence",
    isolation.schema_id,
    P03_BOOTSTRAP_ROLES.isolation,
    [input.attempt_ref, b.runtime_policy_ref]
  );
  const output = input.measured.output;
  const names = attempt.executions.map((entry) => entry.name).sort();
  for (const entry of attempt.executions) {
    if (
      entry.id === null ||
      entry.confinement_projection === null ||
      sha256(entry.confinement_projection) !== entry.confinement_sha256
    )
      throw new Error("p03_bootstrap_v3_confinement_incomplete");
    validateScaP03ConfinementProjectionV3(
      entry.confinement_projection,
      entry.id,
      entry.name,
      attempt.identity.image_id
    );
  }
  if (
    input.measured.disposition !== "completed" ||
    output === null ||
    !Buffer.from(input.measured.witness_bytes).equals(
      readP03BootstrapBytes(store, input.attempt_ref)
    ) ||
    attempt.disposition !== "completed" ||
    attempt.run_id !== input.run_id ||
    attempt.candidate_sha256 !== candidateDigest(input.run_id, b) ||
    !same(attempt.identity, await probe.measureIdentity()) ||
    attempt.identity.image_id !== `sha256:${b.runtime_tree_sha256}` ||
    attempt.identity.runtime_id !== b.runtime_id ||
    attempt.identity.isolation_id !== b.isolation_id ||
    attempt.identity.implementation_sha256 !== b.implementation_identity_sha256 ||
    attempt.identity.deployment_sha256 !== b.deployment_identity_sha256 ||
    !same(cleanup.attempt_ref, input.attempt_ref) ||
    !same(isolation.attempt_ref, input.attempt_ref) ||
    !same(isolation.policy_ref, b.runtime_policy_ref) ||
    !same(isolation.identity, attempt.identity) ||
    cleanup.verifier_id === isolation.verifier_id ||
    cleanup.record_input_sha256 !==
      sha256(
        canonicalJson({
          attempt_ref: input.attempt_ref,
          runtime_policy_ref: b.runtime_policy_ref,
          implementation_identity_ref: b.implementation_identity_ref,
          runtime_identity_ref: b.runtime_identity_ref,
          implementation_source_refs: b.implementation_source_refs,
        })
      ) ||
    cleanup.decision !== "PASS" ||
    isolation.decision !== "PASS" ||
    !same(
      cleanup.containers.map((x) => x.name),
      names
    ) ||
    !same(
      isolation.containers.map((x) => x.name),
      names
    ) ||
    attempt.executions.some(
      (x) =>
        x.id === null ||
        cleanup.containers.find((c) => c.name === x.name)?.id !== x.id ||
        isolation.containers.find((c) => c.name === x.name)?.id !== x.id ||
        isolation.containers.find((c) => c.name === x.name)?.confinement_sha256 !==
          x.confinement_sha256
    ) ||
    !exactP03BootstrapObservations(
      corpus,
      release,
      b.fixture_content_refs.map((ref) => fixture(store, ref)),
      output,
      b.source_oracle_validation_ref
    ) ||
    Date.parse(cleanup.observed_at) < Date.parse(attempt.ended_at) ||
    Date.parse(isolation.observed_at) < Date.parse(attempt.ended_at)
  )
    throw new Error("p03_bootstrap_v3_finalization_incomplete");
  if (
    (await probe.containerCensus(names)).length !== 0 ||
    (await probe.workspaceIdentityDigest(attempt.attempt_id)) !== attempt.workspace_sha256
  )
    throw new Error("p03_bootstrap_v3_finalization_census_invalid");
  await censusScaP03WorkspaceV1(await probe.workspacePaths(attempt.attempt_id));
  const implementation_closure_sha256 = await measureScaP03BuildClosureV3(
    store,
    probe,
    b.implementation_source_refs
  );
  const runtime_package_closure_sha256 = await measureScaP03BuildClosureV3(
    store,
    probe,
    [...b.runtime_package_refs].sort((a, c) => a.artifact_id.localeCompare(c.artifact_id))
  );
  if (runtime_package_closure_sha256 !== attempt.identity.runtime_package_sha256)
    throw new Error("p03_host_build_drift");
  const draft = {
    ...b,
    schema_id: SCA_P03_BOOTSTRAP_RECORD_V3_SCHEMA,
    schema_version: 3 as const,
    evidence_class: "live" as const,
    attempt_witness_ref: input.attempt_ref,
    cleanup_evidence_ref: input.cleanup_ref,
    host_isolation_evidence_ref: input.isolation_ref,
    implementation_closure_sha256,
    runtime_package_closure_sha256,
    executed_query_release_sha256: output.executed_query_release_sha256,
    observations: output.cases.map((entry) => ({ ...entry })),
    exact_expected_observations: true,
    cleanup_verified: true,
    host_isolation_verified: true,
    evaluated_at: probe.now().toISOString(),
  };
  if (
    Date.parse(draft.evaluated_at) <
    Math.max(Date.parse(cleanup.observed_at), Date.parse(isolation.observed_at))
  )
    throw new Error("p03_bootstrap_v3_finalization_time_invalid");
  return validateScaP03BootstrapQualificationRecordV3({
    ...draft,
    record_sha256: sha256(canonicalJson(draft)),
  });
}

/** Production finalization refuses positive evidence if accepted P01 roots drift at either edge. */
export async function finalizeScaP03ProductionBootstrapRecordV1(input: {
  run_id: string;
  production_bindings: ScaP03FrozenProductionBindingsV1;
  measured: ScaP03MeasuredBootstrapV3;
  attempt_ref: ArtifactRef;
  cleanup_ref: ArtifactRef;
  isolation_ref: ArtifactRef;
  implementation_refs: readonly ArtifactRef[];
  store: ArtifactHostStore & ScaP03BootstrapArtifactReaderV1;
  probe: ScaP03BootstrapHostProbeV1;
}): Promise<ScaP03BootstrapQualificationRecordV3> {
  const { production_bindings: production, ...rest } = input;
  readP03ProductionInputs(input.store, production);
  const record = await finalizeScaP03BootstrapRecordV3({
    ...rest,
    bindings: production.frozen,
  });
  readP03ProductionInputs(input.store, production);
  return record;
}
