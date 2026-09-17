import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract } from "../contracts.js";
import { OpaqueIdSchema, Sha256Schema } from "../skill-contracts/common.js";
import {
  SCA_REQUIRED_MODEL_PROFILES,
  ScaModelRegistryV1Schema,
  validateScaModelRegistryV1,
} from "./agent-models.js";
import {
  ScaCandidateAnalysisResultV1Schema,
  ScaDeepAnalysisPlanV1Schema,
  validateScaCandidateAnalysisResultV1,
  validateScaDeepAnalysisPlanV1,
  type ScaCandidateAnalysisResultV1,
  type ScaDeepAnalysisPlanV1,
} from "./deep-analysis-contracts.js";
import {
  ScaM1ManifestV1Schema,
  validateScaM1ManifestV1,
  type ScaM1ManifestV1,
} from "./static-normalization.js";

const MAX_ANALYSES = 100_000;
const MAX_RECORDS = 100_000;
const MAX_TEXT = 8_192;

export const SCA_M2_PROOF_INPUT_SCHEMA = "penny.sca-m2-proof-input.v1";
export const SCA_M2_MANIFEST_SCHEMA = "penny.sca-m2-manifest.v1";

const ScaModelProfileIdV1Schema = Type.Union([
  Type.Literal("primary_a"),
  Type.Literal("primary_b"),
  Type.Literal("critic"),
]);

const ScaCalibrationEvidenceV1Schema = Type.Object(
  {
    profile_id: ScaModelProfileIdV1Schema,
    fixture_suite_sha256: Sha256Schema,
    evidence_sha256: Sha256Schema,
    result: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
    fixture_count: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    false_positive_count: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
    false_negative_count: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  },
  { additionalProperties: false }
);

export const ScaM2ProofInputV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_M2_PROOF_INPUT_SCHEMA),
    schema_version: Type.Literal(1),
    m1_manifest: ScaM1ManifestV1Schema,
    plan: ScaDeepAnalysisPlanV1Schema,
    model_registry: ScaModelRegistryV1Schema,
    analyses: Type.Array(ScaCandidateAnalysisResultV1Schema, {
      maxItems: MAX_ANALYSES,
    }),
    calibration_evidence: Type.Array(ScaCalibrationEvidenceV1Schema, {
      minItems: 3,
      maxItems: 64,
    }),
  },
  { additionalProperties: false }
);

const ScaConsensusTupleV1Schema = Type.Object(
  {
    disposition: Type.Union([
      Type.Literal("confirmed"),
      Type.Literal("rejected"),
      Type.Literal("inconclusive"),
    ]),
    severity: Type.Union([
      Type.Literal("critical"),
      Type.Literal("high"),
      Type.Literal("medium"),
      Type.Literal("low"),
      Type.Literal("informational"),
      Type.Literal("unknown"),
    ]),
    reachability: Type.Union([
      Type.Literal("reachable"),
      Type.Literal("unreachable"),
      Type.Literal("unknown"),
    ]),
  },
  { additionalProperties: false }
);

const ScaM2CandidateConsensusV1Schema = Type.Object(
  {
    candidate_id: OpaqueIdSchema,
    status: Type.Union([Type.Literal("provisional"), Type.Literal("unresolved")]),
    consensus: Type.Union([ScaConsensusTupleV1Schema, Type.Null()]),
    agreeing_profiles: Type.Array(ScaModelProfileIdV1Schema, { maxItems: 3 }),
    dissenting_profiles: Type.Array(ScaModelProfileIdV1Schema, { maxItems: 3 }),
    requested_action_count: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false }
);

const ScaM2DissentV1Schema = Type.Object(
  {
    candidate_id: OpaqueIdSchema,
    profile_id: ScaModelProfileIdV1Schema,
    differs_on: Type.Array(
      Type.Union([
        Type.Literal("disposition"),
        Type.Literal("severity"),
        Type.Literal("reachability"),
      ]),
      { minItems: 1, maxItems: 3 }
    ),
    observed: ScaConsensusTupleV1Schema,
  },
  { additionalProperties: false }
);

const ScaM2FileCoverageV1Schema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
    status: Type.Union([Type.Literal("complete"), Type.Literal("incomplete")]),
    completed_profiles: Type.Array(ScaModelProfileIdV1Schema, { maxItems: 3 }),
    incomplete_profiles: Type.Array(ScaModelProfileIdV1Schema, { maxItems: 3 }),
    candidate_ids_created: Type.Array(OpaqueIdSchema, { maxItems: 10_000 }),
  },
  { additionalProperties: false }
);

const ScaM2BlockerV1Schema = Type.Object(
  {
    code: Type.Union([
      Type.Literal("m1_not_passed"),
      Type.Literal("binding_mismatch"),
      Type.Literal("candidate_plan_mismatch"),
      Type.Literal("file_plan_mismatch"),
      Type.Literal("missing_analysis"),
      Type.Literal("duplicate_analysis"),
      Type.Literal("analysis_incomplete"),
      Type.Literal("analysis_coverage_mismatch"),
      Type.Literal("quorum_unresolved"),
      Type.Literal("file_coverage_incomplete"),
      Type.Literal("calibration_missing"),
      Type.Literal("calibration_failed"),
    ]),
    subject_id: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    detail: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
  },
  { additionalProperties: false }
);

const ScaM2ModelLineageV1Schema = Type.Object(
  {
    profile_id: ScaModelProfileIdV1Schema,
    provider_id: Type.String({ minLength: 1, maxLength: 256 }),
    model_id: Type.String({ minLength: 1, maxLength: 256 }),
    runtime_identity_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export const ScaM2ManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_M2_MANIFEST_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    m1_manifest_sha256: Sha256Schema,
    plan_sha256: Sha256Schema,
    model_registry_sha256: Sha256Schema,
    milestone: Type.Literal("M2_DEEP_ANALYSIS"),
    release_eligible: Type.Literal(false),
    stronger_execution_authorized: Type.Literal(false),
    status: Type.Union([Type.Literal("passed"), Type.Literal("blocked")]),
    model_lineage: Type.Array(ScaM2ModelLineageV1Schema, { minItems: 3, maxItems: 3 }),
    candidate_consensus: Type.Array(ScaM2CandidateConsensusV1Schema, {
      maxItems: MAX_RECORDS,
    }),
    dissent: Type.Array(ScaM2DissentV1Schema, { maxItems: MAX_RECORDS }),
    file_coverage: Type.Array(ScaM2FileCoverageV1Schema, { maxItems: MAX_RECORDS }),
    calibration_evidence: Type.Array(ScaCalibrationEvidenceV1Schema, {
      minItems: 3,
      maxItems: 64,
    }),
    blockers: Type.Array(ScaM2BlockerV1Schema, { maxItems: MAX_RECORDS }),
    manifest_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export type ScaM2ProofInputV1 = Static<typeof ScaM2ProofInputV1Schema>;
export type ScaM2ManifestV1 = Static<typeof ScaM2ManifestV1Schema>;

type Blocker = ScaM2ManifestV1["blockers"][number];
type CandidateConsensus = ScaM2ManifestV1["candidate_consensus"][number];
type Dissent = ScaM2ManifestV1["dissent"][number];
type FileCoverage = ScaM2ManifestV1["file_coverage"][number];
type UnsignedManifest = Omit<ScaM2ManifestV1, "manifest_sha256">;
type Verdict = ScaCandidateAnalysisResultV1["candidate_verdicts"][number];

export class ScaM2ProofError extends Error {
  constructor(
    readonly code: "invalid_input" | "manifest_digest_mismatch",
    message: string
  ) {
    super(message);
    this.name = "ScaM2ProofError";
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function expectedCandidateIds(m1: ScaM1ManifestV1): string[] {
  return m1.observations
    .filter((observation) =>
      [
        "candidate",
        "advisory",
        "secret_candidate",
        "parse_gap",
        "unsupported",
        "tool_failure",
      ].includes(observation.observation_kind)
    )
    .map((observation) => observation.observation_id)
    .sort(compareUtf8);
}

function expectedRequiredFiles(m1: ScaM1ManifestV1): string[] {
  return [
    ...new Set(
      m1.observations.flatMap((observation): readonly string[] =>
        observation.observation_kind === "coverage" &&
        observation.analyzer_kinds.includes("source_census") &&
        observation.path !== null &&
        /^(?:php|javascript|typescript):/u.test(observation.message)
          ? [observation.path]
          : []
      )
    ),
  ].sort(compareUtf8);
}

function addBlocker(blockers: Blocker[], code: Blocker["code"], subject: string, detail: string) {
  blockers.push({ code, subject_id: subject, detail });
}

function exactSet(left: readonly string[], right: readonly string[]): boolean {
  return canonicalJson([...left].sort(compareUtf8)) === canonicalJson([...right].sort(compareUtf8));
}

function tuple(verdict: Verdict) {
  return {
    disposition: verdict.disposition,
    severity: verdict.severity,
    reachability: verdict.reachability,
  };
}

function consensusForCandidate(
  candidateId: string,
  verdicts: readonly { profile_id: ScaCandidateAnalysisResultV1["profile_id"]; verdict: Verdict }[],
  blockers: Blocker[]
): { consensus: CandidateConsensus; dissent: readonly Dissent[] } {
  const groups = new Map<string, typeof verdicts>();
  for (const item of verdicts) {
    const key = canonicalJson(tuple(item.verdict));
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const winner = [...groups.values()]
    .filter((group) => group.length >= 2)
    .sort((left, right) => right.length - left.length)[0];
  if (winner === undefined) {
    addBlocker(
      blockers,
      "quorum_unresolved",
      candidateId,
      "No two required profiles agree on disposition, severity, and reachability"
    );
    return {
      consensus: {
        candidate_id: candidateId,
        status: "unresolved",
        consensus: null,
        agreeing_profiles: [],
        dissenting_profiles: verdicts.map((item) => item.profile_id).sort(compareUtf8),
        requested_action_count: verdicts.reduce(
          (total, item) => total + item.verdict.requested_actions.length,
          0
        ),
      },
      dissent: [],
    };
  }
  const firstWinner = winner[0];
  if (firstWinner === undefined) {
    throw new ScaM2ProofError("invalid_input", "SCA quorum winner is unexpectedly empty");
  }
  const selected = tuple(firstWinner.verdict);
  const agreeing = new Set(winner.map((item) => item.profile_id));
  const dissent = verdicts
    .filter((item) => !agreeing.has(item.profile_id))
    .map((item): Dissent => {
      const observed = tuple(item.verdict);
      const differsOn: Dissent["differs_on"] = [];
      if (observed.disposition !== selected.disposition) differsOn.push("disposition");
      if (observed.severity !== selected.severity) differsOn.push("severity");
      if (observed.reachability !== selected.reachability) differsOn.push("reachability");
      return {
        candidate_id: candidateId,
        profile_id: item.profile_id,
        differs_on: differsOn,
        observed,
      };
    });
  return {
    consensus: {
      candidate_id: candidateId,
      status: "provisional",
      consensus: selected,
      agreeing_profiles: [...agreeing].sort(compareUtf8),
      dissenting_profiles: dissent.map((item) => item.profile_id).sort(compareUtf8),
      requested_action_count: verdicts.reduce(
        (total, item) => total + item.verdict.requested_actions.length,
        0
      ),
    },
    dissent,
  };
}

function analysesByTargetProfile(
  analyses: readonly ScaCandidateAnalysisResultV1[],
  blockers: Blocker[]
): Map<string, ScaCandidateAnalysisResultV1> {
  const indexed = new Map<string, ScaCandidateAnalysisResultV1>();
  for (const analysis of analyses) {
    const key = `${analysis.target_id}\u0000${analysis.profile_id}`;
    if (indexed.has(key)) {
      addBlocker(
        blockers,
        "duplicate_analysis",
        analysis.target_id,
        `Duplicate ${analysis.profile_id} result`
      );
      continue;
    }
    indexed.set(key, analysis);
  }
  return indexed;
}

function validateAnalysisBinding(
  analysis: ScaCandidateAnalysisResultV1,
  m1: ScaM1ManifestV1,
  plan: ScaDeepAnalysisPlanV1
): boolean {
  return (
    analysis.tenant_id === m1.tenant_id &&
    analysis.project_id === m1.project_id &&
    analysis.run_id === m1.run_id &&
    analysis.source_snapshot_sha256 === m1.source_snapshot_sha256 &&
    analysis.m1_manifest_sha256 === m1.manifest_sha256 &&
    analysis.plan_sha256 === plan.plan_sha256
  );
}

function calibrationBlockers(
  evidence: readonly ScaM2ProofInputV1["calibration_evidence"][number][],
  blockers: Blocker[]
): void {
  for (const profileId of SCA_REQUIRED_MODEL_PROFILES) {
    const profileEvidence = evidence.filter((entry) => entry.profile_id === profileId);
    if (profileEvidence.length === 0) {
      addBlocker(blockers, "calibration_missing", profileId, "No calibration evidence supplied");
    } else if (profileEvidence.some((entry) => entry.result !== "passed")) {
      addBlocker(
        blockers,
        "calibration_failed",
        profileId,
        "Calibration evidence contains a failure"
      );
    }
  }
}

function manifestDigest(value: UnsignedManifest): string {
  return sha256(canonicalJson(value));
}

export function buildScaM2ManifestV1(value: unknown): ScaM2ManifestV1 {
  let input: ScaM2ProofInputV1;
  try {
    input = validateContract(ScaM2ProofInputV1Schema, value, "SCA M2 proof input");
  } catch (error) {
    throw new ScaM2ProofError(
      "invalid_input",
      error instanceof Error ? error.message : "SCA M2 proof input is invalid"
    );
  }
  const m1 = validateScaM1ManifestV1(input.m1_manifest);
  const plan = validateScaDeepAnalysisPlanV1(input.plan);
  const registry = validateScaModelRegistryV1(input.model_registry);
  const analyses = input.analyses.map((analysis) => validateScaCandidateAnalysisResultV1(analysis));
  const blockers: Blocker[] = [];
  const candidateConsensus: CandidateConsensus[] = [];
  const dissent: Dissent[] = [];
  const fileCoverage: FileCoverage[] = [];

  if (m1.status !== "passed") {
    addBlocker(blockers, "m1_not_passed", "M1_STATIC_FOUNDATION", "M1 did not pass");
  }
  if (
    plan.tenant_id !== m1.tenant_id ||
    plan.project_id !== m1.project_id ||
    plan.run_id !== m1.run_id ||
    plan.source_snapshot_sha256 !== m1.source_snapshot_sha256 ||
    plan.m1_manifest_sha256 !== m1.manifest_sha256 ||
    plan.model_registry_sha256 !== registry.registry_sha256
  ) {
    addBlocker(
      blockers,
      "binding_mismatch",
      plan.plan_sha256,
      "M1, plan, or registry binding differs"
    );
  }
  if (!exactSet(plan.candidate_ids, expectedCandidateIds(m1))) {
    addBlocker(
      blockers,
      "candidate_plan_mismatch",
      plan.plan_sha256,
      "Plan candidate set differs from the complete M1 candidate set"
    );
  }
  if (!exactSet(plan.required_files, expectedRequiredFiles(m1))) {
    addBlocker(
      blockers,
      "file_plan_mismatch",
      plan.plan_sha256,
      "Plan required-file set differs from security-relevant source coverage"
    );
  }

  const indexed = analysesByTargetProfile(analyses, blockers);
  for (const target of plan.targets) {
    const targetResults: ScaCandidateAnalysisResultV1[] = [];
    for (const profileId of target.required_profiles) {
      const analysis = indexed.get(`${target.target_id}\u0000${profileId}`);
      if (analysis === undefined) {
        addBlocker(blockers, "missing_analysis", target.target_id, `Missing ${profileId} result`);
        continue;
      }
      targetResults.push(analysis);
      if (!validateAnalysisBinding(analysis, m1, plan)) {
        addBlocker(
          blockers,
          "binding_mismatch",
          target.target_id,
          `${profileId} result binding differs`
        );
      }
      if (analysis.status !== "completed") {
        addBlocker(
          blockers,
          "analysis_incomplete",
          target.target_id,
          `${profileId} result is ${analysis.status}`
        );
      }
      if (
        !exactSet(
          analysis.candidate_verdicts.map((verdict) => verdict.candidate_id),
          target.candidate_ids
        ) ||
        !exactSet(
          analysis.file_assessments.map((assessment) => assessment.path),
          target.required_files
        )
      ) {
        addBlocker(
          blockers,
          "analysis_coverage_mismatch",
          target.target_id,
          `${profileId} result does not cover the exact target`
        );
      }
    }

    for (const candidateId of target.candidate_ids) {
      const verdicts = targetResults.flatMap((analysis) => {
        const verdict = analysis.candidate_verdicts.find(
          (candidateVerdict) => candidateVerdict.candidate_id === candidateId
        );
        return verdict === undefined ? [] : [{ profile_id: analysis.profile_id, verdict }];
      });
      if (verdicts.length !== SCA_REQUIRED_MODEL_PROFILES.length) continue;
      const resolved = consensusForCandidate(candidateId, verdicts, blockers);
      candidateConsensus.push(resolved.consensus);
      dissent.push(...resolved.dissent);
    }

    for (const file of target.required_files) {
      const completedProfiles: ScaCandidateAnalysisResultV1["profile_id"][] = [];
      const incompleteProfiles: ScaCandidateAnalysisResultV1["profile_id"][] = [];
      const candidateIds = new Set<string>();
      for (const analysis of targetResults) {
        const assessment = analysis.file_assessments.find((entry) => entry.path === file);
        if (assessment?.coverage === "complete") completedProfiles.push(analysis.profile_id);
        else incompleteProfiles.push(analysis.profile_id);
        for (const candidateId of assessment?.candidate_ids_created ?? []) {
          candidateIds.add(candidateId);
        }
      }
      const complete = completedProfiles.length === SCA_REQUIRED_MODEL_PROFILES.length;
      if (!complete) {
        addBlocker(
          blockers,
          "file_coverage_incomplete",
          file,
          "Not every required profile completed source-file analysis"
        );
      }
      fileCoverage.push({
        path: file,
        status: complete ? "complete" : "incomplete",
        completed_profiles: completedProfiles.sort(compareUtf8),
        incomplete_profiles: incompleteProfiles.sort(compareUtf8),
        candidate_ids_created: [...candidateIds].sort(compareUtf8),
      });
    }
  }
  calibrationBlockers(input.calibration_evidence, blockers);

  const unsigned: UnsignedManifest = {
    schema_id: SCA_M2_MANIFEST_SCHEMA,
    schema_version: 1,
    tenant_id: m1.tenant_id,
    project_id: m1.project_id,
    run_id: m1.run_id,
    source_snapshot_sha256: m1.source_snapshot_sha256,
    m1_manifest_sha256: m1.manifest_sha256,
    plan_sha256: plan.plan_sha256,
    model_registry_sha256: registry.registry_sha256,
    milestone: "M2_DEEP_ANALYSIS",
    release_eligible: false,
    stronger_execution_authorized: false,
    status: blockers.length === 0 ? "passed" : "blocked",
    model_lineage: registry.profiles.map((profile) => ({
      profile_id: profile.profile_id,
      provider_id: profile.provider_id,
      model_id: profile.model_id,
      runtime_identity_sha256: profile.runtime_identity_sha256,
    })),
    candidate_consensus: candidateConsensus.sort((left, right) =>
      compareUtf8(left.candidate_id, right.candidate_id)
    ),
    dissent: dissent.sort((left, right) =>
      compareUtf8(
        `${left.candidate_id}\u0000${left.profile_id}`,
        `${right.candidate_id}\u0000${right.profile_id}`
      )
    ),
    file_coverage: fileCoverage.sort((left, right) => compareUtf8(left.path, right.path)),
    calibration_evidence: [...input.calibration_evidence].sort((left, right) =>
      compareUtf8(left.profile_id, right.profile_id)
    ),
    blockers,
  };
  return validateContract(
    ScaM2ManifestV1Schema,
    { ...unsigned, manifest_sha256: manifestDigest(unsigned) },
    "SCA M2 manifest"
  );
}

export function validateScaM2ManifestV1(value: unknown): ScaM2ManifestV1 {
  const manifest = validateContract(ScaM2ManifestV1Schema, value, "SCA M2 manifest");
  const { manifest_sha256: observedDigest, ...unsigned } = manifest;
  if (manifestDigest(unsigned) !== observedDigest) {
    throw new ScaM2ProofError("manifest_digest_mismatch", "SCA M2 manifest digest mismatch");
  }
  return manifest;
}
