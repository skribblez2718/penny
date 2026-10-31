import path from "node:path";
import { previewArtifactRef, type ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../../orchestration/dist/contracts.js";
import {
  validateScaP03P01RuntimeIdentityRootV1,
  type ScaP03AcceptedP01BindingsV1,
  type ScaP03P01RuntimeRootSelectionV1,
} from "../../orchestration/dist/sca/p03-p01-runtime-root.js";
import {
  SCA_P03_QUERY_IDS,
  SCA_P03_PRODUCTION_INPUT_CONTRACTS,
  projectSourceOracleCases,
  parseSourceOracleReviewV1Bytes,
  scaP03OracleBoundReleaseSha256V2,
  validateScaP03BaselineQuerySetV2,
  validateScaP03ImplementationIdentityV1,
  validateScaP03JoernRuntimeIdentityV1,
  validateScaP03QualificationFixtureContentV1,
  validateScaP03QualificationFixtureCorpusV2,
  validateScaP03QualificationProfileV2,
  validateScaP03QueryBindingAgainstPlanV2,
  validateScaP03QueryPlanV2,
  validateScaP03QueryScriptV2,
  validateScaP03RuntimePolicyV1,
  SCA_P03_SOURCE_ORACLE_PRODUCER,
  SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
  SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
  SCA_P03_SOURCE_ORACLE_SCHEMA,
  SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
  SCA_P03_SOURCE_ORACLE_VALIDATOR,
  type ScaP03QualificationProfileV2,
  type ScaP03QueryId,
  type ScaP03RuntimePolicyV1,
} from "../../orchestration/dist/sca/p03-contracts.js";
import {
  checkArtifact,
  createScaP03FrozenProductionBindingsV1,
  P03_BOOTSTRAP_EVIDENCE_SCHEMAS,
  P03_BOOTSTRAP_ROLES,
  readP03BootstrapBytes,
  readP03BootstrapInputs,
  readP03ProductionInputs,
  type ScaP03FrozenBootstrapBindingsV3,
  type ScaP03FrozenProductionBindingsV1,
} from "./p03-bootstrap.js";
import {
  validateAndSealSourceOracle,
  validateSourceOracleBytes,
  validateSourceSemantics,
} from "./p03-source-oracle.js";
import type { ScaP03DockerCandidateConfigV1 } from "./p03-docker-runtime.js";

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const digest = <T extends Record<string, unknown>>(
  value: T,
  key: string
): T & Record<string, string> => ({ ...value, [key]: sha256(canonicalJson(value)) });
const ordered = (refs: readonly ArtifactRef[]): ArtifactRef[] =>
  [...refs].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
const implementationRoles = ["source", "build", "normalizer", "query_runner"] as const;
type ImplementationFile = ScaP03FreezeManifestV3["implementation"][number];

/** Preview the exact per-file slots, so config identity is independently reproducible before persistence. */
export function planScaP03ImplementationV3(
  run_id: string,
  implementation_id: string,
  implementation_revision: string,
  files: readonly ImplementationFile[]
): {
  identity: ReturnType<typeof validateScaP03ImplementationIdentityV1>;
  mappings: readonly (ImplementationFile & { ref: ArtifactRef; operation_id: string })[];
} {
  const paths = new Set<string>();
  const counts = new Map<string, number>();
  if (files.length < 4 || files.length > 128) throw new Error("p03_freeze_implementation_invalid");
  for (const file of files) {
    counts.set(file.role, (counts.get(file.role) ?? 0) + 1);
    if (
      !implementationRoles.includes(file.role) ||
      !path.isAbsolute(file.path) ||
      file.path === "/" ||
      path.normalize(file.path) !== file.path ||
      paths.has(file.path) ||
      file.bytes.byteLength === 0 ||
      file.bytes.byteLength > 16 * 1024 * 1024 ||
      !Buffer.from(file.bytes).equals(file.current_bytes)
    )
      throw new Error("p03_freeze_implementation_invalid");
    paths.add(file.path);
  }
  if (
    files.reduce((total, file) => total + file.bytes.byteLength, 0) > 32 * 1024 * 1024 ||
    implementationRoles.some((role) => (counts.get(role) ?? 0) < 1 || (counts.get(role) ?? 0) > 64)
  )
    throw new Error("p03_freeze_implementation_invalid");
  const mappings = implementationRoles.flatMap((role) =>
    files
      .filter((file) => file.role === role)
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file, index) => {
        const operation_id = `freeze-implementation-${role}-${String(index)}`;
        const ref = previewArtifactRef({
          metadata: {
            schema_version: 2,
            run_id,
            phase: "SCA-P03",
            branch_id: null,
            kind: "sca-p03-implementation-source",
            operation_id,
            version: 1,
            producer: P03_BOOTSTRAP_ROLES.frozen,
            media_type: "application/octet-stream",
            content_schema: {
              schema_id: "penny.sca-p03-implementation-source.v1",
              schema_version: 1,
            },
            parent_ref: null,
            upstream_refs: [],
          },
          content: file.bytes,
        });
        return { ...file, operation_id, ref };
      })
  );
  const byRole = (role: (typeof implementationRoles)[number]) =>
    sha256(
      canonicalJson(
        mappings
          .filter((file) => file.role === role)
          .map((file) => ({ ref: file.ref, current_sha256: sha256(file.current_bytes) }))
          .sort((a, b) => a.ref.artifact_id.localeCompare(b.ref.artifact_id))
      )
    );
  return {
    mappings,
    identity: validateScaP03ImplementationIdentityV1(
      digest(
        {
          schema_id: "penny.sca-p03-implementation-identity.v1",
          schema_version: 1,
          implementation_id,
          implementation_revision,
          source_sha256: byRole("source"),
          build_sha256: byRole("build"),
          normalizer_sha256: byRole("normalizer"),
          query_runner_sha256: byRole("query_runner"),
        },
        "implementation_sha256"
      )
    ),
  };
}

/** All bytes are supplied by the caller. This function performs no filesystem or Docker reads. */
export interface ScaP03FreezeManifestV3 {
  readonly run_id: string;
  readonly corpus_id: string;
  readonly query_set_id: string;
  readonly release_id: string;
  readonly implementation_id: string;
  readonly implementation_revision: string;
  readonly root_tool_id: string;
  readonly policy_id: string;
  readonly profile: ScaP03QualificationProfileV2;
  readonly policy: ScaP03RuntimePolicyV1;
  readonly config: ScaP03DockerCandidateConfigV1;
  /** Observed externally; image bytes and inaccessible image internals are not claimed. */
  readonly measured: Readonly<{
    docker_executable_bytes: Uint8Array;
    docker_client_version: string;
    docker_server_version: string;
    image_ref: string;
    image_id: string;
    joern_version: string;
    php_frontend_version: string;
    javascript_frontend_version: string;
    jvm_version: string;
    php_runtime_version: string;
    helper_version: string;
  }>;
  readonly oracle_bytes: Uint8Array;
  readonly review_ref: ArtifactRef;
  readonly review_bytes: Uint8Array;
  readonly validated_at: string;
  readonly fixtures: readonly Readonly<{
    language: "php" | "javascript" | "typescript";
    bytes: Uint8Array;
  }>[];
  /** Four explicitly tagged exact deployed files, including current bytes read independently by caller. */
  readonly implementation: readonly Readonly<{
    role: "source" | "build" | "normalizer" | "query_runner";
    path: string;
    bytes: Uint8Array;
    current_bytes: Uint8Array;
  }>[];
}

export interface ScaP03FrozenBuilderResultV3 {
  readonly bindings: ScaP03FrozenBootstrapBindingsV3;
  readonly refs: readonly ArtifactRef[];
  readonly fixture_bytes: readonly Uint8Array[];
  readonly config: ScaP03DockerCandidateConfigV1;
  readonly implementation_mappings: readonly Readonly<{
    role: string;
    path: string;
    ref: ArtifactRef;
    bytes: Uint8Array;
  }>[];
  readonly package_descriptors: readonly Readonly<{ ref: ArtifactRef; bytes: Uint8Array }>[];
}

export interface ScaP03ProductionFreezeManifestV1 extends ScaP03FreezeManifestV3 {
  readonly accepted_p01: ScaP03AcceptedP01BindingsV1;
  readonly toolchain_ref: ArtifactRef;
  readonly root_executable_ref: ArtifactRef;
  readonly root_measurement_ref: ArtifactRef;
}

export interface ScaP03FrozenProductionResultV1 extends ScaP03FrozenBuilderResultV3 {
  readonly production_bindings: ScaP03FrozenProductionBindingsV1;
  readonly p01_runtime_root: ScaP03P01RuntimeRootSelectionV1;
}

/** A logical slot is immutable. Retry adopts only a complete matching ref, object, and manifest row. */
function persistExact(input: {
  store: ArtifactStore;
  run_id: string;
  kind: string;
  operation_id: string;
  producer: string;
  schema_id: string;
  schema_version: number;
  upstream?: readonly ArtifactRef[];
  content: Uint8Array | string;
  media_type?: string;
}): ArtifactRef {
  const { store } = input;
  const bytes = Buffer.from(input.content);
  const metadata: Extract<OutputArtifactMetadata, { schema_version: 2 }> = {
    schema_version: 2,
    run_id: input.run_id,
    phase: "SCA-P03",
    branch_id: null,
    kind: input.kind,
    operation_id: input.operation_id,
    version: 1,
    producer: input.producer,
    media_type: input.media_type ?? "application/json",
    content_schema: { schema_id: input.schema_id, schema_version: input.schema_version },
    parent_ref: null,
    upstream_refs: [...(input.upstream ?? [])],
  };
  const proposed = previewArtifactRef({ metadata, content: bytes });
  const version = store.lastVersion(input.run_id, "SCA-P03", null, input.kind, input.operation_id);
  if (version > 1) throw new Error("p03_freeze_slot_conflict");
  const ref =
    version === 0
      ? store.persist({ metadata, content: bytes })
      : store.refById(proposed.artifact_id);
  if (
    ref === undefined ||
    !same(ref, proposed) ||
    !same(store.metadata(ref), metadata) ||
    !Buffer.from(store.read(ref)).equals(bytes) ||
    !same(store.refById(ref.artifact_id), ref)
  )
    throw new Error("p03_freeze_adopt_conflict");
  return ref;
}

/** No positive binding is returned until all immutable artifacts pass exact readback and native replay. */
function freezeScaP03V3(
  store: ArtifactStore,
  manifest: ScaP03FreezeManifestV3,
  p01RuntimeRoot?: ScaP03P01RuntimeRootSelectionV1
): ScaP03FrozenBuilderResultV3 {
  const m = manifest;
  const oracle = validateSourceOracleBytes(m.oracle_bytes);
  const review = parseSourceOracleReviewV1Bytes(m.review_bytes);
  const profile = validateScaP03QualificationProfileV2(m.profile);
  const policy = validateScaP03RuntimePolicyV1(m.policy);
  const cfg = m.config;
  const measurements = m.measured;
  const expectedCases = projectSourceOracleCases(oracle);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(m.run_id))
    throw new Error("p03_freeze_implementation_invalid");
  const plannedImplementation = planScaP03ImplementationV3(
    m.run_id,
    m.implementation_id,
    m.implementation_revision,
    m.implementation
  );
  const fixtures = (["php", "javascript", "typescript"] as const).map((language) => {
    const candidates = m.fixtures.filter((x) => x.language === language);
    const entry = oracle.fixtures.find((x) => x.language === language);
    if (
      m.fixtures.length !== 3 ||
      candidates.length !== 1 ||
      entry === undefined ||
      candidates[0] === undefined
    )
      throw new Error("p03_freeze_fixture_roster_invalid");
    validateSourceSemantics(entry, candidates[0].bytes);
    const value = validateScaP03QualificationFixtureContentV1({
      schema_id: "penny.sca-p03-qualification-fixture-content.v1",
      schema_version: 1,
      fixture_id: entry.fixture_id,
      language,
      path: entry.path,
      encoding: "base64",
      content_base64: Buffer.from(candidates[0].bytes).toString("base64"),
      byte_length: candidates[0].bytes.byteLength,
      content_sha256: sha256(candidates[0].bytes),
    });
    if (entry.content_sha256 !== value.content_sha256) throw new Error("p03_freeze_fixture_drift");
    return { value, bytes: candidates[0].bytes };
  });
  if (
    review.oracle_sha256 !== oracle.oracle_sha256 ||
    review.parser_identity_sha256 !== oracle.parser.identity_sha256 ||
    !same(
      review.fixture_content_sha256,
      fixtures.map((x) => x.value.content_sha256)
    ) ||
    !same(review.expected_cases, expectedCases) ||
    m.review_ref.run_id !== m.run_id ||
    m.review_ref.content_digest !== sha256(m.review_bytes) ||
    !Buffer.from(readP03BootstrapBytes(store, m.review_ref)).equals(m.review_bytes)
  )
    throw new Error("p03_freeze_independent_review_invalid");
  if (
    cfg.expected_docker_executable_sha256 !== sha256(measurements.docker_executable_bytes) ||
    cfg.expected_docker_client_version !== measurements.docker_client_version ||
    cfg.expected_docker_server_version !== measurements.docker_server_version ||
    cfg.image_ref !== measurements.image_ref ||
    cfg.expected_joern_version !== measurements.joern_version ||
    m.policy_id !== policy.policy_id ||
    sha256(cfg.staging_parent) !== policy.staging_parent_sha256 ||
    cfg.timeout_ms !== policy.process_timeout_ms ||
    cfg.max_num_def !== policy.max_num_def ||
    cfg.isolation_profile_sha256 !== profile.profile_sha256 ||
    !/^sha256:[a-f0-9]{64}$/.test(measurements.image_id) ||
    [
      measurements.joern_version,
      measurements.php_frontend_version,
      measurements.javascript_frontend_version,
      measurements.jvm_version,
      measurements.php_runtime_version,
      measurements.helper_version,
    ].some((x) => !x)
  )
    throw new Error("p03_freeze_package_measurement_invalid");
  const deployment = sha256(
    canonicalJson({
      docker_executable_sha256: cfg.expected_docker_executable_sha256,
      docker_client_version: measurements.docker_client_version,
      docker_server_version: measurements.docker_server_version,
      image_id: measurements.image_id,
      joern_version: measurements.joern_version,
    })
  );
  if (deployment !== cfg.deployment_identity_sha256) throw new Error("p03_freeze_deployment_drift");
  const refs: ArtifactRef[] = [];
  const planned: Parameters<typeof persistExact>[0][] = [];
  const put = (
    kind: string,
    operation_id: string,
    producer: string,
    schema_id: string,
    schema_version: number,
    value: unknown,
    upstream: readonly ArtifactRef[] = [],
    media_type?: string
  ): ArtifactRef => {
    if (media_type === "application/octet-stream" && !(value instanceof Uint8Array))
      throw new Error("p03_freeze_binary_input_invalid");
    const content = value instanceof Uint8Array ? value : canonicalJson(value);
    const entry = {
      store,
      run_id: m.run_id,
      kind,
      operation_id,
      producer,
      schema_id,
      schema_version,
      upstream,
      content,
      ...(media_type === undefined ? {} : { media_type }),
    };
    const ref = previewArtifactRef({
      metadata: {
        schema_version: 2,
        run_id: m.run_id,
        phase: "SCA-P03",
        branch_id: null,
        kind,
        operation_id,
        version: 1,
        producer,
        media_type: media_type ?? "application/json",
        content_schema: { schema_id, schema_version },
        parent_ref: null,
        upstream_refs: [...upstream],
      },
      content,
    });
    planned.push(entry);
    refs.push(ref);
    return ref;
  };
  const putProduction = (
    contract: (typeof SCA_P03_PRODUCTION_INPUT_CONTRACTS)[keyof typeof SCA_P03_PRODUCTION_INPUT_CONTRACTS],
    operation_id: string,
    value: unknown,
    upstream: readonly ArtifactRef[] = []
  ): ArtifactRef =>
    put(
      contract.kind,
      operation_id,
      contract.producer,
      contract.content_schema.schema_id,
      contract.content_schema.schema_version,
      value,
      upstream
    );
  const anticipatedOracleRef = previewArtifactRef({
    metadata: {
      schema_version: 2,
      run_id: m.run_id,
      phase: "SCA-P03",
      branch_id: null,
      kind: "sca-p03-source-oracle",
      operation_id: "freeze-oracle",
      version: 1,
      producer: SCA_P03_SOURCE_ORACLE_PRODUCER,
      media_type: "application/json",
      content_schema: { schema_id: SCA_P03_SOURCE_ORACLE_SCHEMA, schema_version: 2 },
      parent_ref: null,
      upstream_refs: [],
    },
    content: canonicalJson(oracle),
  });
  checkArtifact(store, m.review_ref, {
    run_id: m.run_id,
    kind: "sca-p03-source-oracle-review",
    schema_id: SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
    schema_version: 1,
    producer: SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
    parent: null,
    upstream: [anticipatedOracleRef],
  });
  if (cfg.implementation_identity_sha256 !== plannedImplementation.identity.implementation_sha256)
    throw new Error("p03_freeze_implementation_identity_drift");
  const fixtureRefs = fixtures.map((entry, i) =>
    putProduction(
      SCA_P03_PRODUCTION_INPUT_CONTRACTS.fixture_content,
      `freeze-fixture-${String(i)}`,
      entry.value
    )
  );
  const corpus = validateScaP03QualificationFixtureCorpusV2(
    digest(
      {
        schema_id: "penny.sca-p03-qualification-fixture-corpus.v2",
        schema_version: 2,
        corpus_id: m.corpus_id,
        fixture_content_refs: fixtureRefs,
        fixture_ids: fixtures.map((x) => x.value.fixture_id),
        languages: ["php", "javascript", "typescript"],
        expected_cases: expectedCases,
      },
      "corpus_sha256"
    )
  );
  const corpusRef = putProduction(
    SCA_P03_PRODUCTION_INPUT_CONTRACTS.fixture_corpus,
    "freeze-corpus",
    corpus,
    fixtureRefs
  );
  const oracleRef = put(
    "sca-p03-source-oracle",
    "freeze-oracle",
    SCA_P03_SOURCE_ORACLE_PRODUCER,
    SCA_P03_SOURCE_ORACLE_SCHEMA,
    2,
    oracle
  );
  checkArtifact(store, m.review_ref, {
    run_id: m.run_id,
    kind: "sca-p03-source-oracle-review",
    schema_id: SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
    schema_version: 1,
    producer: SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
    parent: null,
    upstream: [oracleRef],
  });
  const receipt = validateAndSealSourceOracle({
    oracle_bytes: m.oracle_bytes,
    oracle_ref: oracleRef,
    review_ref: m.review_ref,
    corpus_ref: corpusRef,
    corpus,
    fixtures: fixtures.map((entry, i) => ({
      ref:
        fixtureRefs[i] ??
        (() => {
          throw new Error("p03_freeze_fixture_ref_missing");
        })(),
      fixture_id: entry.value.fixture_id,
      language: entry.value.language,
      path: entry.value.path,
      content_sha256: entry.value.content_sha256,
      bytes: entry.bytes,
    })),
    validated_at: m.validated_at,
  });
  const receiptRef = put(
    "sca-p03-source-oracle-validation",
    "freeze-oracle-validation",
    SCA_P03_SOURCE_ORACLE_VALIDATOR,
    SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
    1,
    receipt,
    ordered([oracleRef, corpusRef, ...fixtureRefs, m.review_ref])
  );
  const queryEntries = SCA_P03_QUERY_IDS.map((query_id: ScaP03QueryId, index) => {
    const edge =
      query_id === "p03.call-resolution.v2" || query_id === "p03.framework-dispatch.v2"
        ? "call"
        : query_id === "p03.control-guard.v2"
          ? "cfg"
          : query_id === "p03.dataflow-source-sink.v2"
            ? "reaching_def"
            : null;
    const plan = validateScaP03QueryPlanV2(
      digest(
        {
          schema_id: "penny.sca-p03-query-plan.v2",
          schema_version: 2,
          plan_id: `p03-plan-${String(index)}`,
          query_id,
          steps: [
            {
              kind: "select_node",
              node_class:
                query_id === "p03.call-resolution.v2" || query_id === "p03.framework-dispatch.v2"
                  ? "call"
                  : query_id === "p03.control-guard.v2"
                    ? "control_structure"
                    : query_id === "p03.dataflow-source-sink.v2"
                      ? "identifier"
                      : "method",
            },
            { kind: "filter_property", property: "file_name", operator: "present", value: null },
            ...(edge === "reaching_def"
              ? [{ kind: "filter_property", property: "name", operator: "present", value: null }]
              : []),
            ...(edge === null
              ? []
              : [{ kind: "traverse_edge", edge, max_hops: edge === "reaching_def" ? 16 : 1 }]),
            { kind: "project", fields: ["file_name", "line_number"] },
            { kind: "limit", max_items: policy.max_query_items },
          ],
          max_ast_depth: policy.max_ast_depth,
          max_ast_nodes: policy.max_ast_nodes,
        },
        "plan_sha256"
      )
    );
    const planRef = putProduction(
      SCA_P03_PRODUCTION_INPUT_CONTRACTS.query_plan,
      `freeze-plan-${String(index)}`,
      plan
    );
    const binding = {
      schema_id: "penny.sca-p03-query-binding.v2",
      schema_version: 2,
      release_id: m.release_id,
      query_id,
      executor_id: query_id,
      plan_id: plan.plan_id,
      plan_sha256: plan.plan_sha256,
    };
    const scriptBytes = Buffer.from(canonicalJson(binding));
    const script = validateScaP03QueryScriptV2({
      schema_id: "penny.sca-p03-query-script.v2",
      schema_version: 2,
      query_id,
      script_id: `p03-script-${String(index)}`,
      language: "penny_typed_query_binding_v2",
      review_status: "host_reviewed_frozen",
      encoding: "base64",
      content_base64: scriptBytes.toString("base64"),
      byte_length: scriptBytes.byteLength,
      content_sha256: sha256(scriptBytes),
    });
    const scriptRef = putProduction(
      SCA_P03_PRODUCTION_INPUT_CONTRACTS.query_script,
      `freeze-script-${String(index)}`,
      script
    );
    const checkedBinding = validateScaP03QueryBindingAgainstPlanV2({
      release_id: m.release_id,
      query_id,
      script,
      plan,
    });
    return { query_id, plan, planRef, scriptRef, script, binding: checkedBinding };
  });
  const querySet = validateScaP03BaselineQuerySetV2(
    digest(
      {
        schema_id: "penny.sca-p03-baseline-query-set.v2",
        schema_version: 2,
        query_set_id: m.query_set_id,
        release_id: m.release_id,
        native_query_authorized: false,
        ordered_queries: queryEntries.map((q) => ({
          query_id: q.query_id,
          script_ref: q.scriptRef,
          script_sha256: q.scriptRef.content_digest,
          plan_ref: q.planRef,
          plan_sha256: q.planRef.content_digest,
        })),
      },
      "query_set_sha256"
    )
  );
  const scriptRefs = queryEntries.map((q) => q.scriptRef);
  const planRefs = queryEntries.map((q) => q.planRef);
  const setRef = putProduction(
    SCA_P03_PRODUCTION_INPUT_CONTRACTS.baseline_query_set,
    "freeze-query-set",
    querySet,
    [...scriptRefs, ...planRefs]
  );
  const profileRef = putProduction(
    SCA_P03_PRODUCTION_INPUT_CONTRACTS.qualification_profile,
    "freeze-profile",
    profile
  );
  const policyRef = putProduction(
    SCA_P03_PRODUCTION_INPUT_CONTRACTS.runtime_policy,
    "freeze-policy",
    policy
  );
  const mappings = plannedImplementation.mappings.map((entry) => ({
    ...entry,
    ref: put(
      "sca-p03-implementation-source",
      entry.operation_id,
      P03_BOOTSTRAP_ROLES.frozen,
      "penny.sca-p03-implementation-source.v1",
      1,
      entry.bytes,
      [],
      "application/octet-stream"
    ),
  }));
  const implementationRefs = ordered(mappings.map((x) => x.ref));
  const implementation = plannedImplementation.identity;
  if (
    !same(
      mappings.map((x) => x.ref),
      plannedImplementation.mappings.map((x) => x.ref)
    )
  )
    throw new Error("p03_freeze_implementation_ref_drift");
  if (cfg.implementation_identity_sha256 !== implementation.implementation_sha256)
    throw new Error("p03_freeze_implementation_identity_drift");
  const implementationRef = putProduction(
    SCA_P03_PRODUCTION_INPUT_CONTRACTS.implementation_identity,
    "freeze-implementation",
    implementation,
    implementationRefs
  );
  const packageValues = [
    {
      kind: "docker_executable",
      sha256: cfg.expected_docker_executable_sha256,
      docker_client_version: measurements.docker_client_version,
      docker_server_version: measurements.docker_server_version,
    },
    {
      kind: "image_identity",
      image_id: measurements.image_id,
      digest_scope: "daemon_reported_image_id_only",
    },
    {
      kind: "toolchain_versions",
      joern_version: measurements.joern_version,
      php_frontend_version: measurements.php_frontend_version,
      javascript_frontend_version: measurements.javascript_frontend_version,
      jvm_version: measurements.jvm_version,
      php_runtime_version: measurements.php_runtime_version,
      helper_version: measurements.helper_version,
    },
  ];
  const packageDescriptors = packageValues.map((value, i) => {
    const bytes = Buffer.from(canonicalJson(value));
    const ref = put(
      "sca-p03-runtime-package",
      `freeze-package-${String(i)}`,
      P03_BOOTSTRAP_ROLES.frozen,
      P03_BOOTSTRAP_EVIDENCE_SCHEMAS.package,
      1,
      value
    );
    return { ref, bytes };
  });
  const packageRefs = ordered(packageDescriptors.map((x) => x.ref));
  const bootstrapRoot = {
    root_tool_id: m.root_tool_id,
    root_executable_ref:
      packageDescriptors[0]?.ref ??
      (() => {
        throw new Error("p03_freeze_package_missing");
      })(),
    root_measurement_ref:
      packageDescriptors[1]?.ref ??
      (() => {
        throw new Error("p03_freeze_package_missing");
      })(),
    toolchain_ref:
      packageDescriptors[2]?.ref ??
      (() => {
        throw new Error("p03_freeze_package_missing");
      })(),
  };
  const selectedRoot = p01RuntimeRoot ?? bootstrapRoot;
  const runtime = validateScaP03JoernRuntimeIdentityV1(
    digest(
      {
        schema_id: "penny.sca-p03-joern-runtime-identity.v1",
        schema_version: 1,
        runtime_id: cfg.runtime_id,
        runtime_kind: "host_qualified_joern",
        qualification_scope: "live_qualified",
        root_tool_id: selectedRoot.root_tool_id,
        root_executable_ref: selectedRoot.root_executable_ref,
        root_measurement_ref: selectedRoot.root_measurement_ref,
        toolchain_ref: selectedRoot.toolchain_ref,
        runtime_package_refs: packageRefs,
        runtime_tree_sha256: measurements.image_id.slice(7),
        joern_version: measurements.joern_version,
        php_frontend_version: measurements.php_frontend_version,
        javascript_frontend_version: measurements.javascript_frontend_version,
        jvm_version: measurements.jvm_version,
        php_runtime_version: measurements.php_runtime_version,
        helper_version: measurements.helper_version,
      },
      "identity_sha256"
    )
  );
  const runtimeIdentityUpstream = ordered(
    [
      ...packageRefs,
      runtime.toolchain_ref,
      runtime.root_executable_ref,
      runtime.root_measurement_ref,
    ].filter((ref, index, refs) => refs.findIndex((candidate) => same(candidate, ref)) === index)
  );
  const runtimeRef = putProduction(
    SCA_P03_PRODUCTION_INPUT_CONTRACTS.runtime_identity,
    "freeze-runtime-identity",
    runtime,
    runtimeIdentityUpstream
  );
  const releaseSha = scaP03OracleBoundReleaseSha256V2({
    query_set_id: m.query_set_id,
    release_id: m.release_id,
    query_set_sha256: querySet.query_set_sha256,
    queries: queryEntries.map((q) => ({
      query_id: q.query_id,
      script_id: q.script.script_id,
      script_sha256: q.script.content_sha256,
      binding: q.binding,
      plan: q.plan,
    })),
    oracle_ref: corpusRef,
    oracle: corpus,
  });
  const bindings: ScaP03FrozenBootstrapBindingsV3 = {
    fixture_corpus_ref: corpusRef,
    source_oracle_ref: oracleRef,
    source_oracle_validation_ref: receiptRef,
    source_oracle_review_ref: m.review_ref,
    parser_identity_sha256: oracle.parser.identity_sha256,
    baseline_query_set_ref: setRef,
    qualification_profile_ref: profileRef,
    runtime_policy_ref: policyRef,
    implementation_identity_ref: implementationRef,
    runtime_identity_ref: runtimeRef,
    fixture_content_refs: fixtureRefs,
    query_script_refs: scriptRefs,
    query_plan_refs: planRefs,
    runtime_package_refs: packageRefs,
    implementation_source_refs: implementationRefs,
    runtime_id: cfg.runtime_id,
    isolation_id: cfg.isolation_id,
    runtime_tree_sha256: measurements.image_id.slice(7),
    joern_version: measurements.joern_version,
    max_num_def: policy.max_num_def,
    implementation_identity_sha256: implementation.implementation_sha256,
    deployment_identity_sha256: deployment,
    profile_id: profile.profile_id,
    profile_sha256: profile.profile_sha256,
    release_id: m.release_id,
    release_sha256: releaseSha,
  };
  for (const [index, entry] of planned.entries()) {
    if (!same(persistExact(entry), refs[index])) throw new Error("p03_freeze_persist_ref_drift");
  }
  readP03BootstrapInputs(store, bindings, m.run_id);
  return {
    bindings,
    refs: [...refs, m.review_ref],
    fixture_bytes: fixtures.map((x) => x.bytes),
    config: cfg,
    implementation_mappings: mappings.map((x) => ({
      role: x.role,
      path: x.path,
      ref: x.ref,
      bytes: x.bytes,
    })),
    package_descriptors: packageDescriptors,
  };
}

/** Standalone bootstrap/component freeze. Its local descriptors are not P01 lineage. */
export function freezeScaP03BootstrapV3(
  store: ArtifactStore,
  manifest: ScaP03FreezeManifestV3
): ScaP03FrozenBuilderResultV3 {
  return freezeScaP03V3(store, manifest);
}

/**
 * Production freeze. Accepted P01 roots are exact-read and validated before any P03 artifact is
 * persisted; bootstrap runtime descriptors remain a separate runtime-package closure.
 */
export function freezeScaP03ProductionV1(
  store: ArtifactStore,
  manifest: ScaP03ProductionFreezeManifestV1
): ScaP03FrozenProductionResultV1 {
  const p01RuntimeRoot = validateScaP03P01RuntimeIdentityRootV1({
    store,
    accepted_p01: manifest.accepted_p01,
    runtime: {
      root_tool_id: manifest.root_tool_id,
      toolchain_ref: manifest.toolchain_ref,
      root_executable_ref: manifest.root_executable_ref,
      root_measurement_ref: manifest.root_measurement_ref,
      joern_version: manifest.measured.joern_version,
    },
  });
  const frozen = freezeScaP03V3(store, manifest, p01RuntimeRoot);
  const productionBindings = createScaP03FrozenProductionBindingsV1({
    run_id: manifest.run_id,
    frozen: frozen.bindings,
    roots: {
      accepted_p01: manifest.accepted_p01,
      root_tool_id: manifest.root_tool_id,
      toolchain_ref: manifest.toolchain_ref,
      root_executable_ref: manifest.root_executable_ref,
      root_measurement_ref: manifest.root_measurement_ref,
    },
  });
  readP03ProductionInputs(store, productionBindings);
  return {
    ...frozen,
    production_bindings: productionBindings,
    p01_runtime_root: p01RuntimeRoot,
  };
}
