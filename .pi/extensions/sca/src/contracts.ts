import {
  SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V2,
  SCA_BROKER_SCHEMA_MANIFEST_SHA256,
  validateScaBrokerSchemaDigestManifestV2,
} from "../../../../apps/orchestration/dist/sca/broker-contracts.js";

export * from "../../../../apps/orchestration/dist/sca/broker-contracts.js";

/** Current broker manifest. Update only through an explicit contract-version task. */
export const SCA_EXTENSION_BROKER_MANIFEST_SHA256 =
  "33958bee2a6f0f0c2bb7f17429b8d9f1278871a757b47f42b584bee196eab696" as const;

const manifest = validateScaBrokerSchemaDigestManifestV2(SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V2);
const consumerEntry = manifest.consumers.find(
  (candidate) => candidate.module_path === ".pi/extensions/sca/src/contracts.ts"
);

if (SCA_BROKER_SCHEMA_MANIFEST_SHA256 !== SCA_EXTENSION_BROKER_MANIFEST_SHA256) {
  throw new Error("SCA broker manifest digest does not match the current contract");
}
if (
  consumerEntry?.integration !== "generated_digest_lock_v2" ||
  consumerEntry.canonical_source !== "apps/orchestration/src/sca/broker-contracts.ts" ||
  consumerEntry.generated_bundle_export !== "SCA_BROKER_SCHEMA_BUNDLE_V2" ||
  consumerEntry.manifest_export !== "SCA_BROKER_SCHEMA_DIGEST_MANIFEST_V2"
) {
  throw new Error("SCA broker manifest does not declare the required extension consumer boundary");
}
