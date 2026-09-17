import { Type, type Static } from "typebox";

import { validateContract } from "../contracts.js";
import { OpaqueIdSchema, Sha256Schema } from "../skill-contracts/common.js";
import {
  ScaModelExecutionRequestV1Schema,
  admitScaModelExecutionV1,
  type ScaModelExecutionAdmissionV1,
  type ScaModelExecutionRequestV1,
  type ScaModelRegistryV1,
} from "./agent-models.js";
import {
  validateScaCandidateAnalysisResultV1,
  type ScaCandidateAnalysisResultV1,
} from "./deep-analysis-contracts.js";

export const SCA_MODEL_ANALYSIS_INVOCATION_SCHEMA = "penny.sca-model-analysis-invocation.v1";

export const ScaModelAnalysisInvocationV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_MODEL_ANALYSIS_INVOCATION_SCHEMA),
    schema_version: Type.Literal(1),
    execution_request: ScaModelExecutionRequestV1Schema,
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    m1_manifest_sha256: Sha256Schema,
    plan_sha256: Sha256Schema,
    target_id: Type.String({ pattern: "^scatarget_[a-f0-9]{64}$" }),
    context_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export type ScaModelAnalysisInvocationV1 = Static<typeof ScaModelAnalysisInvocationV1Schema>;

export interface ScaAnalysisModelCallV1 {
  readonly admission: ScaModelExecutionAdmissionV1;
  readonly context_sha256: string;
}

export interface ScaAnalysisModelInvokerV1 {
  invoke(call: ScaAnalysisModelCallV1): Promise<unknown>;
}

export class ScaModelExecutionError extends Error {
  constructor(
    readonly code:
      | "invalid_invocation"
      | "model_failed"
      | "output_invalid"
      | "output_binding_mismatch",
    message: string
  ) {
    super(message);
    this.name = "ScaModelExecutionError";
  }
}

function exactOutputBinding(
  invocation: ScaModelAnalysisInvocationV1,
  request: ScaModelExecutionRequestV1,
  admission: ScaModelExecutionAdmissionV1,
  output: ScaCandidateAnalysisResultV1
): boolean {
  return (
    output.tenant_id === invocation.tenant_id &&
    output.project_id === invocation.project_id &&
    output.run_id === request.run_id &&
    output.source_snapshot_sha256 === invocation.source_snapshot_sha256 &&
    output.m1_manifest_sha256 === invocation.m1_manifest_sha256 &&
    output.plan_sha256 === invocation.plan_sha256 &&
    output.target_id === invocation.target_id &&
    output.target_id === request.candidate_id &&
    output.profile_id === request.profile_id &&
    output.model_admission_sha256 === admission.admission_sha256
  );
}

export async function executeScaModelAnalysisV1(
  registry: ScaModelRegistryV1,
  invocationValue: unknown,
  invoker: ScaAnalysisModelInvokerV1
): Promise<ScaCandidateAnalysisResultV1> {
  let invocation: ScaModelAnalysisInvocationV1;
  try {
    invocation = validateContract(
      ScaModelAnalysisInvocationV1Schema,
      invocationValue,
      "SCA model analysis invocation"
    );
  } catch (error) {
    throw new ScaModelExecutionError(
      "invalid_invocation",
      error instanceof Error ? error.message : "SCA model analysis invocation is invalid"
    );
  }
  const admission = admitScaModelExecutionV1(registry, invocation.execution_request);
  let rawOutput: unknown;
  try {
    rawOutput = await invoker.invoke({
      admission,
      context_sha256: invocation.context_sha256,
    });
  } catch {
    throw new ScaModelExecutionError("model_failed", "SCA analysis model invocation failed");
  }
  let output: ScaCandidateAnalysisResultV1;
  try {
    output = validateScaCandidateAnalysisResultV1(rawOutput);
  } catch (error) {
    throw new ScaModelExecutionError(
      "output_invalid",
      error instanceof Error ? error.message : "SCA analysis model output is invalid"
    );
  }
  if (!exactOutputBinding(invocation, invocation.execution_request, admission, output)) {
    throw new ScaModelExecutionError(
      "output_binding_mismatch",
      "SCA analysis model output differs from the admitted invocation"
    );
  }
  return output;
}
