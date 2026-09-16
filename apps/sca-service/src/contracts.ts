import {
  SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V1,
  SCA_BROKER_SCHEMA_MANIFEST_SHA256,
  validateScaBrokerSchemaDigestManifestV1,
} from "../../orchestration/src/sca/broker-contracts.js";

export * from "../../orchestration/src/sca/broker-contracts.js";

/** Accepted S-03-T1 broker manifest. Update only through an explicit contract-version task. */
export const SCA_SERVICE_BROKER_MANIFEST_SHA256 =
  "a96a2e8371d0d5b123be7ef4fb725a5cf29264034030c2cef7b5bf96ea18b715" as const;

const manifest = validateScaBrokerSchemaDigestManifestV1(SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V1);
const consumerEntry = manifest.consumers.find(
  (candidate) => candidate.module_path === "apps/sca-service/src/contracts.ts"
);

if (SCA_BROKER_SCHEMA_MANIFEST_SHA256 !== SCA_SERVICE_BROKER_MANIFEST_SHA256) {
  throw new Error("SCA broker manifest digest does not match the accepted S-03-T1 contract");
}
if (
  consumerEntry?.integration !== "generated_digest_lock_v1" ||
  consumerEntry.canonical_source !== "apps/orchestration/src/sca/broker-contracts.ts" ||
  consumerEntry.generated_bundle_export !== "SCA_BROKER_SCHEMA_BUNDLE_V1" ||
  consumerEntry.manifest_export !== "SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V1"
) {
  throw new Error("SCA broker manifest does not declare the required service consumer boundary");
}
