/** One wire contract and one correspondence check, shared with P03 admission. */
export {
  SCA_P03_SOURCE_ORACLE_SCHEMA,
  SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
  SCA_P03_SOURCE_ORACLE_VALIDATOR,
  SourceOracleValidationReceiptSchema,
  parseSourceOracleValidationReceiptBytes,
  assertSourceOracleReceiptCorrespondence,
  sealSourceOracleValidationReceipt,
} from "../../orchestration/dist/sca/p03-contracts.js";
export type { SourceOracleValidationReceipt } from "../../orchestration/dist/sca/p03-contracts.js";
