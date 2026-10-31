import path from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { ArtifactRefSchema, validateContract } from "../../orchestration/dist/contracts.js";
import {
  OpaqueIdSchema,
  Rfc3339UtcSchema,
  Sha256Schema,
} from "../../orchestration/dist/skill-contracts/common.js";

const ProjectId = Type.String({ pattern: "^prj_[a-f0-9]{32}$", minLength: 36, maxLength: 36 });
const AbsolutePath = Type.String({
  minLength: 2,
  maxLength: 4096,
  pattern: "^/[^\\u0000\\r\\n]*$",
});
const Role = Type.Union([
  Type.Literal("source"),
  Type.Literal("build"),
  Type.Literal("normalizer"),
  Type.Literal("query_runner"),
]);
const File = Type.Object({ role: Role, path: AbsolutePath }, { additionalProperties: false });
const Fixture = Type.Object(
  {
    language: Type.Union([
      Type.Literal("php"),
      Type.Literal("javascript"),
      Type.Literal("typescript"),
    ]),
    path: AbsolutePath,
  },
  { additionalProperties: false }
);
const Config = Type.Object(
  {
    docker_executable: AbsolutePath,
    image_ref: Type.String({ minLength: 1, maxLength: 512 }),
    expected_joern_version: Type.String({ minLength: 1, maxLength: 64 }),
    expected_docker_executable_sha256: Sha256Schema,
    expected_docker_client_version: Type.String({ minLength: 1, maxLength: 64 }),
    expected_docker_server_version: Type.String({ minLength: 1, maxLength: 64 }),
    runtime_id: OpaqueIdSchema,
    isolation_id: OpaqueIdSchema,
    isolation_profile_sha256: Sha256Schema,
    implementation_identity_sha256: Sha256Schema,
    deployment_identity_sha256: Sha256Schema,
    staging_parent: AbsolutePath,
    memory_bytes: Type.Integer({ minimum: 268435456, maximum: 68719476736 }),
    cpus: Type.Number({ exclusiveMinimum: 0, maximum: 64 }),
    pids: Type.Integer({ minimum: 16, maximum: 4096 }),
    max_workspace_bytes: Type.Integer({ minimum: 1, maximum: 134217728 }),
    max_num_def: Type.Integer({ minimum: 1, maximum: 1000000 }),
    max_command_output_bytes: Type.Integer({ minimum: 1, maximum: 1048576 }),
    timeout_ms: Type.Integer({ minimum: 1, maximum: 300000 }),
  },
  { additionalProperties: false }
);
const Identity = {
  schema_version: Type.Literal(1),
  store_root: AbsolutePath,
  project_id: ProjectId,
  run_id: OpaqueIdSchema,
  working_dir: AbsolutePath,
  config: Config,
};
const ManifestId = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});
const VersionCommand = Type.Tuple([
  Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", minLength: 1, maxLength: 128 }),
  Type.Union([Type.Literal("--version"), Type.Literal("-version"), Type.Literal("-v")]),
]);
const JoernPhpFrontendVersionCommand = Type.Tuple([
  Type.Literal("find"),
  Type.Literal("/opt/joern"),
  Type.Literal("-type"),
  Type.Literal("f"),
  Type.Literal("-name"),
  Type.Literal("io.joern.php2cpg-*.jar"),
  Type.Literal("-printf"),
  Type.Literal("%f\\n"),
]);
const JoernJavascriptFrontendVersionCommand = Type.Tuple([
  Type.Literal("find"),
  Type.Literal("/opt/joern"),
  Type.Literal("-type"),
  Type.Literal("f"),
  Type.Literal("-name"),
  Type.Literal("io.joern.jssrc2cpg-*.jar"),
  Type.Literal("-printf"),
  Type.Literal("%f\\n"),
]);
const AcceptedP01 = Type.Object(
  {
    request_ref: ArtifactRefSchema,
    obligation_ledger_ref: ArtifactRefSchema,
    campaign_manifest_core_ref: ArtifactRefSchema,
    admission_evidence_ref: ArtifactRefSchema,
    p01_gate_ref: ArtifactRefSchema,
    campaign_manifest_ref: ArtifactRefSchema,
    frozen_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 256 }),
  },
  { additionalProperties: false }
);
export const ScaP03CliFreezeManifestSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-p03-cli-freeze-manifest.v1"),
    ...Identity,
    create_store: Type.Boolean(),
    corpus_id: ManifestId,
    query_set_id: ManifestId,
    release_id: ManifestId,
    implementation_id: ManifestId,
    implementation_revision: ManifestId,
    root_tool_id: ManifestId,
    policy_id: ManifestId,
    oracle_path: AbsolutePath,
    source_oracle_review_path: AbsolutePath,
    profile_path: AbsolutePath,
    policy_path: AbsolutePath,
    fixtures: Type.Array(Fixture, { minItems: 3, maxItems: 3 }),
    implementation: Type.Array(File, { minItems: 4, maxItems: 128 }),
    toolchain_version_commands: Type.Object(
      {
        php_frontend: JoernPhpFrontendVersionCommand,
        javascript_frontend: JoernJavascriptFrontendVersionCommand,
        jvm: VersionCommand,
        php_runtime: VersionCommand,
        helper: VersionCommand,
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type ScaP03CliFreezeManifest = Readonly<Static<typeof ScaP03CliFreezeManifestSchema>>;
export const ScaP03CliProductionFreezeManifestSchema = Type.Object(
  {
    ...ScaP03CliFreezeManifestSchema.properties,
    schema_id: Type.Literal("penny.sca-p03-cli-production-freeze-manifest.v1"),
    create_store: Type.Literal(false),
    accepted_p01: AcceptedP01,
    toolchain_ref: ArtifactRefSchema,
    root_executable_ref: ArtifactRefSchema,
    root_measurement_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);
export type ScaP03CliProductionFreezeManifest = Readonly<
  Static<typeof ScaP03CliProductionFreezeManifestSchema>
>;
const Mapped = Type.Object(
  { role: Role, path: AbsolutePath, ref: ArtifactRefSchema },
  { additionalProperties: false }
);
const FrozenBindings = Type.Object(
  {
    fixture_corpus_ref: ArtifactRefSchema,
    source_oracle_ref: ArtifactRefSchema,
    source_oracle_validation_ref: ArtifactRefSchema,
    source_oracle_review_ref: ArtifactRefSchema,
    parser_identity_sha256: Sha256Schema,
    baseline_query_set_ref: ArtifactRefSchema,
    qualification_profile_ref: ArtifactRefSchema,
    runtime_policy_ref: ArtifactRefSchema,
    implementation_identity_ref: ArtifactRefSchema,
    runtime_identity_ref: ArtifactRefSchema,
    fixture_content_refs: Type.Array(ArtifactRefSchema, { minItems: 3, maxItems: 3 }),
    query_script_refs: Type.Array(ArtifactRefSchema, { minItems: 7, maxItems: 7 }),
    query_plan_refs: Type.Array(ArtifactRefSchema, { minItems: 7, maxItems: 7 }),
    runtime_package_refs: Type.Array(ArtifactRefSchema, { minItems: 3, maxItems: 3 }),
    implementation_source_refs: Type.Array(ArtifactRefSchema, { minItems: 4, maxItems: 128 }),
    runtime_id: OpaqueIdSchema,
    isolation_id: OpaqueIdSchema,
    runtime_tree_sha256: Sha256Schema,
    joern_version: Type.String({ minLength: 1, maxLength: 64 }),
    max_num_def: Type.Integer({ minimum: 1, maximum: 1000000 }),
    implementation_identity_sha256: Sha256Schema,
    deployment_identity_sha256: Sha256Schema,
    profile_id: OpaqueIdSchema,
    profile_sha256: Sha256Schema,
    release_id: OpaqueIdSchema,
    release_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
const ProductionBindings = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-p03-frozen-production-bindings.v1"),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    frozen: FrozenBindings,
    roots: Type.Object(
      {
        accepted_p01: AcceptedP01,
        root_tool_id: ManifestId,
        toolchain_ref: ArtifactRefSchema,
        root_executable_ref: ArtifactRefSchema,
        root_measurement_ref: ArtifactRefSchema,
      },
      { additionalProperties: false }
    ),
    binding_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
const FreezeHandoff = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-p03-cli-freeze-handoff.v1"),
    schema_version: Type.Literal(1),
    store_root: AbsolutePath,
    project_id: ProjectId,
    run_id: OpaqueIdSchema,
    status: Type.Union([Type.Literal("ready_for_review"), Type.Literal("blocked")]),
    bindings: FrozenBindings,
    mapping_sha256: Sha256Schema,
    attempt_ref: ArtifactRefSchema,
    cleanup_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    isolation_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    record_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
  },
  { additionalProperties: false }
);
export const ScaP03CliFreezeHandoffSchema = FreezeHandoff;
export type ScaP03CliFreezeHandoff = Readonly<Static<typeof FreezeHandoff>>;
export const ScaP03CliProductionFreezeHandoffSchema = Type.Object(
  {
    ...FreezeHandoff.properties,
    schema_id: Type.Literal("penny.sca-p03-cli-production-freeze-handoff.v1"),
    production_bindings: ProductionBindings,
  },
  { additionalProperties: false }
);
export type ScaP03CliProductionFreezeHandoff = Readonly<
  Static<typeof ScaP03CliProductionFreezeHandoffSchema>
>;
export const ScaP03CliFreezeResultSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ready_for_review"), Type.Literal("blocked")]),
    handoff_sha256: Sha256Schema,
    attempt_ref: ArtifactRefSchema,
    cleanup_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    isolation_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    record_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
  },
  { additionalProperties: false }
);
export type ScaP03CliFreezeResult = Readonly<Static<typeof ScaP03CliFreezeResultSchema>>;
export const ScaP03CliSealManifestSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-p03-cli-seal-manifest.v1"),
    ...Identity,
    freeze_handoff_path: AbsolutePath,
    freeze_handoff_sha256: Sha256Schema,
    implementation: Type.Array(Mapped, { minItems: 4, maxItems: 128 }),
    runtime_packages: Type.Array(
      Type.Object({ path: AbsolutePath, ref: ArtifactRefSchema }, { additionalProperties: false }),
      { minItems: 3, maxItems: 3 }
    ),
    external_review_path: AbsolutePath,
    reviewer_public_key_path: AbsolutePath,
    reviewer_public_key_sha256: Sha256Schema,
    reviewer_id: OpaqueIdSchema,
    reviewer_authority_id: OpaqueIdSchema,
    evaluator_id: OpaqueIdSchema,
    attester_id: OpaqueIdSchema,
    attestation_id: OpaqueIdSchema,
  },
  { additionalProperties: false }
);
export type ScaP03CliSealManifest = Readonly<Static<typeof ScaP03CliSealManifestSchema>>;
export const ScaP03CliProductionSealManifestSchema = Type.Object(
  {
    ...ScaP03CliSealManifestSchema.properties,
    schema_id: Type.Literal("penny.sca-p03-cli-production-seal-manifest.v1"),
  },
  { additionalProperties: false }
);
export type ScaP03CliProductionSealManifest = Readonly<
  Static<typeof ScaP03CliProductionSealManifestSchema>
>;
export const ScaP03CliVerifyManifestSchema = Type.Object(
  {
    ...ScaP03CliSealManifestSchema.properties,
    schema_id: Type.Literal("penny.sca-p03-cli-verify-manifest.v1"),
    sealed_handoff_path: AbsolutePath,
    sealed_handoff_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type ScaP03CliVerifyManifest = Readonly<Static<typeof ScaP03CliVerifyManifestSchema>>;
export const ScaP03CliProductionVerifyManifestSchema = Type.Object(
  {
    ...ScaP03CliProductionSealManifestSchema.properties,
    schema_id: Type.Literal("penny.sca-p03-cli-production-verify-manifest.v1"),
    sealed_handoff_path: AbsolutePath,
    sealed_handoff_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type ScaP03CliProductionVerifyManifest = Readonly<
  Static<typeof ScaP03CliProductionVerifyManifestSchema>
>;
export const ScaP03CliSealedHandoffSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-p03-cli-sealed-handoff.v1"),
    schema_version: Type.Literal(1),
    store_root: AbsolutePath,
    project_id: ProjectId,
    run_id: OpaqueIdSchema,
    record_ref: ArtifactRefSchema,
    attempt_ref: ArtifactRefSchema,
    cleanup_ref: ArtifactRefSchema,
    isolation_ref: ArtifactRefSchema,
    external_review_ref: ArtifactRefSchema,
    receipt_ref: ArtifactRefSchema,
    review_ref: ArtifactRefSchema,
    host_attestation_ref: ArtifactRefSchema,
    binding_ref: ArtifactRefSchema,
    mapping_sha256: Sha256Schema,
    proof_sha256: Sha256Schema,
    status: Type.Union([Type.Literal("verified"), Type.Literal("revoked")]),
  },
  { additionalProperties: false }
);
export type ScaP03CliSealedHandoff = Readonly<Static<typeof ScaP03CliSealedHandoffSchema>>;
export const ScaP03CliProductionSealedHandoffSchema = Type.Object(
  {
    ...ScaP03CliSealedHandoffSchema.properties,
    schema_id: Type.Literal("penny.sca-p03-cli-production-sealed-handoff.v1"),
    production_record_ref: ArtifactRefSchema,
    production_binding_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type ScaP03CliProductionSealedHandoff = Readonly<
  Static<typeof ScaP03CliProductionSealedHandoffSchema>
>;
export const ScaP03CliExternalReviewSchema = Type.Object(
  {
    external_review_id: OpaqueIdSchema,
    record_ref: ArtifactRefSchema,
    attempt_ref: ArtifactRefSchema,
    cleanup_ref: ArtifactRefSchema,
    isolation_ref: ArtifactRefSchema,
    reviewer_id: OpaqueIdSchema,
    reviewer_authority_id: OpaqueIdSchema,
    decision: Type.Literal("PASS"),
    reviewed_at: Rfc3339UtcSchema,
    signature: Type.String({ pattern: "^[A-Za-z0-9+/]{86}==$", minLength: 88, maxLength: 88 }),
  },
  { additionalProperties: false }
);
export type ScaP03CliExternalReview = Readonly<Static<typeof ScaP03CliExternalReviewSchema>>;

export function parseScaP03CliCanonical<T extends TSchema>(
  schema: T,
  bytes: Uint8Array
): Static<T> {
  if (bytes.byteLength === 0 || bytes.byteLength > 1024 * 1024)
    throw new Error("p03_cli_input_size_invalid");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const raw: unknown = JSON.parse(text);
  if (canonicalJson(raw) !== text) throw new Error("p03_cli_input_noncanonical");
  const value = validateContract(schema, raw, "P03 CLI input");
  if (canonicalJson(value) !== text) throw new Error("p03_cli_input_noncanonical");
  const content: unknown = value;
  if (
    content !== null &&
    typeof content === "object" &&
    "store_root" in content &&
    "working_dir" in content &&
    "config" in content &&
    typeof content.store_root === "string" &&
    typeof content.working_dir === "string" &&
    content.config !== null &&
    typeof content.config === "object" &&
    "docker_executable" in content.config &&
    "staging_parent" in content.config &&
    typeof content.config.docker_executable === "string" &&
    typeof content.config.staging_parent === "string"
  ) {
    for (const candidate of [
      content.store_root,
      content.working_dir,
      content.config.docker_executable,
      content.config.staging_parent,
    ])
      validateScaP03CliPaths([candidate]);
  }
  if (
    content !== null &&
    typeof content === "object" &&
    "schema_id" in content &&
    (content.schema_id === "penny.sca-p03-cli-freeze-manifest.v1" ||
      content.schema_id === "penny.sca-p03-cli-production-freeze-manifest.v1")
  ) {
    const m =
      content.schema_id === "penny.sca-p03-cli-freeze-manifest.v1"
        ? validateContract(ScaP03CliFreezeManifestSchema, content, "P03 freeze manifest")
        : validateContract(
            ScaP03CliProductionFreezeManifestSchema,
            content,
            "P03 production freeze manifest"
          );
    validateScaP03CliPaths([
      ...m.implementation.map((x) => x.path),
      ...m.fixtures.map((x) => x.path),
      m.oracle_path,
      m.source_oracle_review_path,
      m.profile_path,
      m.policy_path,
    ]);
    if (
      ["source", "build", "normalizer", "query_runner"].some((role) => {
        const count = m.implementation.filter((x) => x.role === role).length;
        return count < 1 || count > 64;
      }) ||
      new Set(m.fixtures.map((x) => x.language)).size !== 3
    )
      throw new Error("p03_cli_roster_invalid");
  }
  if (
    content !== null &&
    typeof content === "object" &&
    "schema_id" in content &&
    (content.schema_id === "penny.sca-p03-cli-seal-manifest.v1" ||
      content.schema_id === "penny.sca-p03-cli-verify-manifest.v1" ||
      content.schema_id === "penny.sca-p03-cli-production-seal-manifest.v1" ||
      content.schema_id === "penny.sca-p03-cli-production-verify-manifest.v1")
  ) {
    const m =
      content.schema_id === "penny.sca-p03-cli-seal-manifest.v1"
        ? validateContract(ScaP03CliSealManifestSchema, content, "P03 seal manifest")
        : content.schema_id === "penny.sca-p03-cli-verify-manifest.v1"
          ? validateContract(ScaP03CliVerifyManifestSchema, content, "P03 verify manifest")
          : content.schema_id === "penny.sca-p03-cli-production-seal-manifest.v1"
            ? validateContract(
                ScaP03CliProductionSealManifestSchema,
                content,
                "P03 production seal manifest"
              )
            : validateContract(
                ScaP03CliProductionVerifyManifestSchema,
                content,
                "P03 production verify manifest"
              );
    validateScaP03CliPaths([
      ...m.implementation.map((x) => x.path),
      ...m.runtime_packages.map((x) => x.path),
    ]);
    const refs = [...m.implementation.map((x) => x.ref), ...m.runtime_packages.map((x) => x.ref)];
    if (
      new Set(refs.map((x) => x.artifact_id)).size !== refs.length ||
      refs.some((ref) => ref.run_id !== m.run_id) ||
      m.runtime_packages.some(
        (entry, i) =>
          i > 0 && entry.ref.artifact_id <= (m.runtime_packages[i - 1]?.ref.artifact_id ?? "")
      ) ||
      ["source", "build", "normalizer", "query_runner"].some((role) => {
        const count = m.implementation.filter((x) => x.role === role).length;
        return count < 1 || count > 64;
      })
    )
      throw new Error("p03_cli_mapping_invalid");
  }
  return value;
}
export function validateScaP03CliPaths(paths: readonly string[]): void {
  if (
    new Set(paths).size !== paths.length ||
    paths.some(
      (p) => !path.isAbsolute(p) || path.normalize(p) !== p || p === "/" || p.includes("\0")
    )
  )
    throw new Error("p03_cli_paths_invalid");
}
export function scaP03CliMappingSha256(
  entries: readonly { role: string; path: string; ref: Static<typeof ArtifactRefSchema> }[]
): string {
  return sha256(
    canonicalJson(entries.map((entry) => ({ role: entry.role, path: entry.path, ref: entry.ref })))
  );
}
