/** Pure source-oracle contracts live in orchestration; native AST verification stays in this service. */
export {
  parseSourceOracleBytes,
  validateSourceFixture,
  projectSourceOracleCases,
  matchesSourceMark,
  matchesSourceRelationship,
} from "../../orchestration/dist/sca/p03-contracts.js";
export type {
  SourceFixture,
  SourceMark,
  SourceOracle,
} from "../../orchestration/dist/sca/p03-contracts.js";
