import {
  SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V2,
  SCA_BROKER_SCHEMA_MANIFEST_SHA256,
  validateScaBrokerSchemaDigestManifestV2,
} from "../../orchestration/dist/sca/broker-contracts.js";

export type * from "../../orchestration/dist/sca/broker-contracts.js";
export {
  classifyScaBrokerIdempotency,
  classifyScaBrokerJobProgressV1,
  SCA_BROKER_CONTRACT_LIMITS_V1,
  SCA_BROKER_PROGRESS_LIMITS_V1,
  SCA_BROKER_SCHEMA_BUNDLE_V1,
  SCA_BROKER_SCHEMA_BUNDLE_V2,
  SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V1,
  SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V2,
  SCA_BROKER_SCHEMA_MANIFEST_SHA256,
  SCA_BROKER_SCHEMA_MANIFEST_SHA256_V1,
  SCA_MODEL_TOOL_ROSTER,
  SCA_TOOL_OPERATION_MAP,
  ScaBrokerCancelRequestV1Schema,
  ScaBrokerCancelResultV1Schema,
  ScaBrokerCapabilityRequestV1Schema,
  ScaBrokerCapabilityResultV1Schema,
  ScaBrokerContractError,
  ScaBrokerErrorCodeSchema,
  ScaBrokerExecuteAcceptedResultV1Schema,
  ScaBrokerExecuteAcceptedResultV2Schema,
  scaBrokerExecuteRequestSha256,
  ScaBrokerExecuteRequestV1Schema,
  ScaBrokerJobProgressV1Schema,
  ScaBrokerOperationKindSchema,
  ScaBrokerPollRequestV1Schema,
  ScaBrokerPollResultV1Schema,
  ScaBrokerPollResultV2Schema,
  ScaBrokerReceiptV1Schema,
  ScaBrokerRepositorySelectorV1Schema,
  ScaBrokerRequestLimitsV1Schema,
  ScaBrokerSchemaDigestManifestV1Schema,
  ScaBrokerSchemaDigestManifestV2Schema,
  scaBrokerSchemaSha256,
  ScaBrokerTerminalStatusSchema,
  ScaBrokerToolNameSchema,
  ScaBrokerTypedErrorV1Schema,
  ScaBrokerTypedParameterV1Schema,
  validateScaBrokerCancelRequestV1,
  validateScaBrokerCancelResultV1,
  validateScaBrokerCapabilityRequestV1,
  validateScaBrokerCapabilityResultV1,
  validateScaBrokerExecuteAcceptedResult,
  validateScaBrokerExecuteAcceptedResultV1,
  validateScaBrokerExecuteAcceptedResultV2,
  validateScaBrokerExecuteRequestV1,
  validateScaBrokerJobProgressV1,
  validateScaBrokerPollRequestV1,
  validateScaBrokerPollResult,
  validateScaBrokerPollResultV1,
  validateScaBrokerPollResultV2,
  validateScaBrokerReceiptV1,
  validateScaBrokerSchemaDigestManifestV1,
  validateScaBrokerSchemaDigestManifestV2,
  validateScaBrokerTypedErrorV1,
} from "../../orchestration/dist/sca/broker-contracts.js";

/** Current broker manifest. Update only through an explicit contract-version task. */
export const SCA_SERVICE_BROKER_MANIFEST_SHA256 =
  "33958bee2a6f0f0c2bb7f17429b8d9f1278871a757b47f42b584bee196eab696" as const;

const manifest = validateScaBrokerSchemaDigestManifestV2(SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V2);
const consumerEntry = manifest.consumers.find(
  (candidate) => candidate.module_path === "apps/sca-service/src/contracts.ts"
);

if (SCA_BROKER_SCHEMA_MANIFEST_SHA256 !== SCA_SERVICE_BROKER_MANIFEST_SHA256) {
  throw new Error("SCA broker manifest digest does not match the current contract");
}
if (
  consumerEntry?.integration !== "generated_digest_lock_v2" ||
  consumerEntry.canonical_source !== "apps/orchestration/src/sca/broker-contracts.ts" ||
  consumerEntry.generated_bundle_export !== "SCA_BROKER_SCHEMA_BUNDLE_V2" ||
  consumerEntry.manifest_export !== "SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V2"
) {
  throw new Error("SCA broker manifest does not declare the required service consumer boundary");
}
