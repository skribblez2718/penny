/** Fabricated component records/transcripts for FAST reader tests. NOT owner/engine E2E. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { Checkpointer } from "../../orchestration/dist/checkpointer.js";
import { validateDirective, type ArtifactRef } from "../../orchestration/dist/contracts.js";
import {
  hostOperationLeaseProfileSha256,
  hostOperationPolicyBinding,
  validateHostOperationCallRecord,
  type HostOperationCallRecordV1,
  type HostOperationDeclarationV1,
} from "../../orchestration/dist/host-operations/contracts.js";
import { createPreparedHostOperationCallRecord } from "../../orchestration/dist/host-operations/storage.js";
import {
  ScaP03InitialProposalBindingV1,
  deriveScaP03InitialCustodyV1,
  validateScaP03InitialProposalV1,
  type ScaP03InitialResourcesV1,
} from "../../orchestration/dist/sca/p03-initial-authorization.js";
import {
  renderScaP03InitialQuestionsV1,
  scaP03InitialOperationInputs,
} from "../../orchestration/dist/sca/p03-initial-qualification.js";
import { scaProposedStartSha256 } from "../../orchestration/dist/sca/qualification-activation.js";
import {
  scaP03FrontendLanguageV1,
  projectScaP03OracleTargetObservationsV2,
  scaP03QualificationObservationSha256V2,
} from "../../orchestration/dist/sca/p03-contracts.js";
import {
  ScaP03CliProductionFreezeHandoffSchema,
  parseScaP03CliCanonical,
} from "../src/p03-bootstrap-cli-contracts.js";
import {
  replayScaP03InitialFixturePreimagesV1,
  type ScaP03PreLiveInputsV1,
  type ScaP03InitialEvidenceV1,
} from "../src/p03-initial-live.js";
import { createScaP03ApprovedInputReaderV1 } from "../src/p03-predecessor-inputs.js";
import { ScaP03HostWitnessSinkV1 } from "../src/p03-bootstrap-witness.js";
import {
  scaP03NativeCreateArgvV1,
  scaP03NativeConfinementProjectionV1,
  parseScaP03NativeInventoryV1,
  scaP03NativeQueryCandidatesV1,
} from "../src/p03-docker-runtime.js";
import { productionSamplerFixture } from "./p03-production-sampler-fixture.js";
import { pinnedInventory } from "./p03-test-oracle.js";

export const consumedResources: ScaP03InitialResourcesV1 = {
  cpus: 2,
  memory_bytes: 1_073_741_824,
  pids: 64,
  tmp_bytes: 8_388_608,
  work_bytes: 58_720_256,
  command_output_bytes: 1_048_576,
  concurrency: 1,
  inactivity_ms: 60_000,
  cleanup_grace_ms: 5000,
  max_commands: 512,
  max_source_bytes: 1_048_576,
  max_source_files: 3,
  max_graph_bytes: 1024,
  max_query_bytes: 524_288,
  max_query_items: 256,
  max_page_items: 64,
  max_pages_per_query: 4,
  max_ast_depth: 256,
  max_ast_nodes: 4096,
  max_num_def: 1000,
  jvm_heap_bytes: 536_870_912,
  max_host_workspace_bytes: 4_194_304,
  max_evidence_bytes: 8_388_608,
};
export async function consumedComponentFixture() {
  const f = await productionSamplerFixture();
  const store = ArtifactStore.openExisting(f.storeRoot, { projectId: f.project_id });
  const checkpointer = Checkpointer.provision(path.join(f.working, "consumed-unit.db"), undefined, {
    projectId: f.project_id,
  });
  const handoff = parseScaP03CliCanonical(
    ScaP03CliProductionFreezeHandoffSchema,
    readFileSync(f.freezePath)
  );
  const b = handoff.bindings,
    roots = handoff.production_bindings.roots;
  let counter = 0;
  const persist = (
    kind: string,
    schema: string,
    content: unknown,
    upstream: readonly ArtifactRef[] = [],
    phase = "SCA-P03",
    producer = "host:sca-p03-initial-authorization",
    operation_id = `consumed-unit:${++counter}`
  ) =>
    store.persist({
      metadata: {
        schema_version: 2,
        run_id: f.run_id,
        phase,
        branch_id: null,
        kind,
        operation_id,
        version: 1,
        producer,
        media_type: "application/json",
        content_schema: { schema_id: schema, schema_version: 1 },
        parent_ref: null,
        upstream_refs: [...upstream],
      },
      content: canonicalJson(content),
    });
  const inert = persist("test-inert-p02", "penny.test-inert-p02.v1", { not_authority: true });
  const start = {
    tenant_id: "test-tenant",
    project_id: f.project_id,
    phase_id: "SCA-P02" as const,
    production_playbook_name: "sca-p02" as const,
    qualification_run_id: "test-p02",
    activation_run_id: "test-p02-activation",
    qualification_ref: inert,
    gate_ref: inert,
  };
  const m: ScaP03PreLiveInputsV1 = {
    schema_id: "penny.sca-p03-pre-live-inputs.v1",
    schema_version: 1,
    run_id: f.run_id,
    tenant_id: "test-tenant",
    project_id: f.project_id,
    ...roots,
    accepted_p02: {
      transition_ref: inert,
      p02_request_ref: inert,
      gate_ref: inert,
      m1_ref: inert,
      coverage_matrix_ref: inert,
      evidence_manifest_ref: inert,
      successor_ledger_ref: inert,
      evidence_refs: Array.from({ length: 26 }, () => inert),
      qualification_definition_ref: inert,
      qualification_gate_ref: inert,
    },
    p02_authority_ref: inert,
    p02_issuance_ref: inert,
    p02_proposed_start: {
      ...start,
      authority_ref: inert,
      proposed_start_sha256: scaProposedStartSha256(start),
    },
    fixture_corpus_ref: b.fixture_corpus_ref,
    fixture_content_refs: [...b.fixture_content_refs],
    source_oracle_ref: b.source_oracle_ref,
    source_oracle_review_ref: b.source_oracle_review_ref,
    source_oracle_validation_ref: b.source_oracle_validation_ref,
    qualification_profile_ref: b.qualification_profile_ref,
    baseline_query_set_ref: b.baseline_query_set_ref,
    query_script_refs: [...b.query_script_refs],
    query_plan_refs: [...b.query_plan_refs],
    deployment_sha256: sha256("unit original protected deployment"),
    configuration_sha256: sha256("unit original private configuration"),
    evidence_destination_sha256: sha256("unit destination"),
    resource_policy_sha256: sha256(canonicalJson(consumedResources)),
  };
  const manifestRef = persist("sca-p03-pre-live-inputs", m.schema_id, m);
  // Test construction only: close the explicitly chosen historical operands, not a reader lookup.
  const chosen = [
    manifestRef,
    inert,
    ...Object.values(roots.accepted_p01).flatMap((v) => (Array.isArray(v) ? v : [v])),
    roots.toolchain_ref,
    roots.root_executable_ref,
    roots.root_measurement_ref,
    b.fixture_corpus_ref,
    ...b.fixture_content_refs,
    b.source_oracle_ref,
    b.source_oracle_review_ref,
    b.source_oracle_validation_ref,
    b.qualification_profile_ref,
    b.baseline_query_set_ref,
    ...b.query_script_refs,
    ...b.query_plan_refs,
  ];
  const closure = new Map<string, ArtifactRef>();
  for (let i = 0; i < chosen.length; i++) {
    const ref = chosen[i];
    if (ref === undefined || closure.has(ref.artifact_id)) continue;
    closure.set(ref.artifact_id, ref);
    const metadata = store.metadata(ref);
    chosen.push(
      ...metadata.upstream_refs,
      ...(metadata.parent_ref === null ? [] : [metadata.parent_ref])
    );
  }
  const input_refs = [...closure.values()].sort((a, b) =>
    a.artifact_id.localeCompare(b.artifact_id)
  );
  const issued = new Date(Date.now() - 60_000).toISOString();
  const proposal = validateScaP03InitialProposalV1({
    schema_id: "penny.sca-p03-initial-proposal.v1",
    schema_version: 1,
    run_id: f.run_id,
    invocation_nonce: "unit-nonce",
    approval_id: "unit-approval",
    project_id: f.project_id,
    principal_id: "unit-principal",
    policy_id: "unit-policy",
    installation_id: "unit-installation",
    revocation_generation: 1,
    state_authority_sha256: sha256("unit state"),
    backend_resource_sha256: sha256("unit backend"),
    deployment_sha256: m.deployment_sha256,
    configuration_sha256: m.configuration_sha256,
    evidence_destination_sha256: m.evidence_destination_sha256,
    fixture_cohort_sha256: b.fixture_corpus_ref.content_digest,
    issued_at: issued,
    not_before: issued,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    resources: consumedResources,
    input_refs,
    effect: "fixture_qualification",
  });
  const proposalRef = persist("sca-p03-initial-proposal", proposal.schema_id, proposal, input_refs);
  const binding = new ScaP03InitialProposalBindingV1(store, proposalRef);
  const questions = renderScaP03InitialQuestionsV1(proposal);
  const transportRef = persist(
    "sca-p03-initial-transport",
    "penny.sca-p03-initial-transport.v1",
    {
      schema_id: "penny.sca-p03-initial-transport.v1",
      schema_version: 1,
      proposal_ref: proposalRef,
      gate_id: "unit-gate",
      challenge: "unit-challenge",
      questions,
    },
    [proposalRef],
    "sca_p03_awaiting_initial_approval",
    "host:sca-p03-initial-authorization",
    "initial:sca-p03-initial-transport"
  );
  const event = {
    schema_version: 2,
    origin: "trusted-human-ui",
    run_id: f.run_id,
    gate_id: "unit-gate",
    challenge: "unit-challenge",
    artifact_ref: proposalRef,
    questionnaire_transport_ref: transportRef,
    rendered_questions_digest: sha256(canonicalJson(questions)),
    actor: "human:interactive-questionnaire",
    timestamp: new Date(Date.now() - 1000).toISOString(),
    decision: "approve",
    response: "approve",
    signature: sha256("fabricated historical operand, not authenticated approval"),
  };
  const witnessRef = persist(
    "sca-p03-initial-witness",
    "penny.sca-p03-initial-witness.v1",
    event,
    [proposalRef, transportRef],
    "sca_p03_awaiting_initial_approval",
    "host:sca-p03-initial-authorization",
    "initial:sca-p03-initial-witness"
  );
  const leaseProfile = {
    profile_id: "sca-p03-initial-backend-lease-v1",
    profile_version: 1 as const,
    duration_ms: 60_000,
    renew_after_ms: 20_000,
    queue_inactivity_ms: 60_000,
  };
  const custody = deriveScaP03InitialCustodyV1(input_refs);
  const declaration: HostOperationDeclarationV1 = {
    schema_version: 1,
    operation_kind: "sca.p03.initial-qualification.v1",
    adapter_id: "sca-p03-initial-qualification-adapter-v1",
    request: {
      schema_version: 1,
      port_name: "initial_proposal",
      artifact_kind: proposalRef.kind,
      schema_id: proposal.schema_id,
      schema_version_required: 1,
    },
    result: {
      schema_version: 1,
      port_name: "initial_evidence",
      artifact_kind: "sca-p03-initial-evidence",
      schema_id: "penny.sca-p03-initial-evidence.v1",
      schema_version_required: 1,
    },
    backend_binding_id: "sca-p03-approved-backend-v1",
    capability_classes: ["artifact_store"],
    lease_profile: {
      ...leaseProfile,
      profile_sha256: hostOperationLeaseProfileSha256(leaseProfile),
    },
    operation_inactivity_ms: 60_000,
    max_request_bytes: 1_048_576,
    max_input_artifacts: custody.max_refs + 3,
    max_input_bytes: custody.max_total_bytes + 3 * 1_048_576,
    max_output_artifacts: 1,
    max_output_bytes: consumedResources.max_evidence_bytes,
    max_progress_events: consumedResources.max_commands * 4,
    max_pre_acceptance_retries: 0,
    recovery_semantics: "journaled_remote_submission_v1",
    cancellation_semantics: "local_abort_only_v1",
  };
  const directive = validateDirective({
    schema_version: 2,
    host_operation_schema_version: 1,
    action: "invoke_host_operation",
    identity: {
      schema_version: 2,
      run_id: f.run_id,
      session_id: "unit-session",
      playbook: "sca-p03-initial-qualification",
      engine_owner: "typescript",
    },
    state_id: "sca_p03_initial_qualification",
    attempt: 1,
    operation_id: "initial:unit-approval:unit-nonce",
    operation_kind: declaration.operation_kind,
    registration_sha256: sha256("unit retained registration"),
    request_ref: proposalRef,
    request_sha256: proposalRef.content_digest,
    input_artifacts: scaP03InitialOperationInputs(
      proposalRef,
      transportRef,
      witnessRef,
      input_refs
    ),
    expected_result: declaration.result,
    policy_binding: hostOperationPolicyBinding(declaration, proposal.backend_resource_sha256),
  });
  if (directive.action !== "invoke_host_operation") throw new Error("unit directive absent");
  const initial = createPreparedHostOperationCallRecord({
    project_id: f.project_id,
    directive,
    timestamp: new Date().toISOString(),
    queue_inactivity_expires_at_ms: Date.now() + 60_000,
    operation_inactivity_expires_at_ms: Date.now() + 60_000,
  });
  const approved = createScaP03ApprovedInputReaderV1(store, input_refs);
  const checked = replayScaP03InitialFixturePreimagesV1({
    proposal,
    reader: {
      read: (ref) => approved.exact(ref).bytes,
      metadata: (ref) => approved.metadata(ref),
      refById: (id) => approved.refById(id),
      readById: (id) => approved.readById(id),
    },
  });
  const environment = {
    docker_executable_sha256: sha256("unit docker"),
    docker_client_version: "1.0.0",
    docker_server_version: "1.0.0",
    image_ref: `fixture/joern@sha256:${sha256("unit image")}`,
    image_id: `sha256:${sha256("unit config")}`,
    joern_version: "4.0.627",
    php_frontend_version: "4.0.627",
    javascript_frontend_version: "4.0.627",
    jvm_version: "17.0.0",
    php_runtime_version: "17.0.0",
    helper_version: "17.0.0",
  };
  const { docker_executable_sha256, ...versions } = environment;
  const witness = new ScaP03HostWitnessSinkV1({
    run_id: f.run_id,
    candidate_sha256: directive.request_sha256,
    identity: {
      runtime_id: "unit-runtime",
      isolation_id: "unit-isolation",
      implementation_sha256: sha256("unit implementation"),
      deployment_sha256: sha256(
        canonicalJson({
          docker_executable_sha256,
          docker_client_version: environment.docker_client_version,
          docker_server_version: environment.docker_server_version,
          image_id: environment.image_id,
          joern_version: environment.joern_version,
        })
      ),
      docker_executable_sha256,
      docker_client_version: environment.docker_client_version,
      docker_server_version: environment.docker_server_version,
      image_id: environment.image_id,
      joern_version: environment.joern_version,
      runtime_package_sha256: sha256(canonicalJson(versions)),
    },
  });
  const observations: ScaP03InitialEvidenceV1["original_observations"] = [];
  const observe = (argv: readonly string[], text: string) => {
    const bytes = Buffer.from(text);
    observations.push({
      ordinal: observations.length + 1,
      argv_sha256: sha256(canonicalJson(argv)),
      output_base64: bytes.toString("base64"),
      output_sha256: sha256(bytes),
      byte_length: bytes.byteLength,
    });
  };
  let group = 0,
    execution = 0;
  const newGroup = () => {
    if (group > 0) witness.finishWorkspace(true);
    witness.startWorkspace(canonicalJson({ path: `/unit/work-${++group}`, dev: 1, ino: group }));
  };
  const imageConfig = { Volumes: null, Labels: { "org.opencontainers.image.version": "unit" } };
  const image = () =>
    observe(
      ["image", "inspect", "--format", "{{json .}}", environment.image_ref],
      canonicalJson({
        Id: environment.image_id,
        RepoDigests: [environment.image_ref],
        Config: imageConfig,
      })
    );
  const container = (
    primary: readonly string[],
    response: string,
    mountKind: "probe" | "parse" | "inventory" = "probe",
    output?: { filename: "graph.cpg.bin" | "inventory.tsv"; bytes: Buffer }
  ) => {
    const ordinal = ++execution,
      seed = sha256(initial.operation_record_id),
      n = sha256(`${seed}:${ordinal}`),
      name = `penny-p03-${n.slice(0, 8)}-${n.slice(8, 12)}-${n.slice(12, 16)}-${n.slice(16, 20)}-${n.slice(20, 32)}`;
    const root = `/unit/work-${group}`,
      id = "e".repeat(64); // deliberately repeated across all executions
    const tmpfs = `/tmp:rw,exec,nosuid,nodev,size=${consumedResources.tmp_bytes}`,
      workspaceTmpfs = `/work:rw,exec,nosuid,nodev,size=${consumedResources.work_bytes},mode=0700,uid=1000,gid=1000`;
    const mounts = [
      { Type: "bind", Source: `${root}/scripts`, Destination: "/scripts", RW: false },
      ...(mountKind === "probe"
        ? []
        : [{ Type: "bind", Source: `${root}/source`, Destination: "/source", RW: false }]),
      ...(mountKind === "inventory"
        ? [{ Type: "bind", Source: `${root}/output`, Destination: "/input", RW: false }]
        : []),
    ];
    const create = scaP03NativeCreateArgvV1({
      config: { ...consumedResources, image_ref: environment.image_ref },
      seed,
      attemptOrdinal: ordinal,
      currentName: name,
      uid: 1000,
      gid: 1000,
      tmpfs,
      workspaceTmpfs,
      mounts: mounts.flatMap((m) => [
        "--mount",
        `type=bind,src=${m.Source},dst=${m.Destination},readonly`,
      ]),
      jvmHeapBytes: consumedResources.jvm_heap_bytes,
    });
    witness.create(name, create);
    observe(create, `${id}\n`);
    witness.id(name, id);
    image();
    const inspected = (running: boolean) => ({
      Id: id,
      Image: environment.image_id,
      Name: `/${name}`,
      State: { Status: running ? "running" : "created", Running: running },
      Mounts: [...mounts].reverse(),
      Config: {
        User: "1000:1000",
        WorkingDir: "/tmp",
        Env: [
          "IMAGE_INHERITED=ok",
          "HOME=/tmp",
          `JAVA_TOOL_OPTIONS=-Xmx${consumedResources.jvm_heap_bytes}`,
        ],
        Entrypoint: ["sleep"],
        Cmd: ["infinity"],
        Labels: {
          ...imageConfig.Labels,
          "penny.sca.p03.operation": seed,
          "penny.sca.p03.attempt": String(ordinal),
        },
      },
      HostConfig: {
        NetworkMode: "none",
        PidMode: "",
        IpcMode: "",
        UTSMode: "",
        ReadonlyRootfs: true,
        Init: true,
        Privileged: false,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        PidsLimit: consumedResources.pids,
        Memory: consumedResources.memory_bytes,
        MemorySwap: consumedResources.memory_bytes,
        NanoCpus: 2_000_000_000,
        LogConfig: { Type: "none" },
        Tmpfs: { "/tmp": tmpfs.slice(5), "/work": workspaceTmpfs.slice(6) },
      },
    });
    observe(
      ["container", "inspect", "--format", "{{json .}}", id],
      JSON.stringify(inspected(false), null, 2) + "\n"
    );
    observe(["container", "start", id], "not prescribed\n");
    const running = inspected(true);
    observe(
      ["container", "inspect", "--format", "{{json .}}", id],
      JSON.stringify(running, null, 2) + "\n"
    );
    witness.inspect(name, canonicalJson(running), scaP03NativeConfinementProjectionV1(running));
    witness.startContainer(name);
    const command = ["container", "exec", id, ...primary];
    witness.command(name, command, output !== undefined);
    observe(command, response);
    witness.response(name, response);
    if (output !== undefined) {
      observe(
        [
          "container",
          "exec",
          id,
          "python3",
          "/scripts/readback.py",
          output.filename,
          String(
            output.filename === "graph.cpg.bin"
              ? consumedResources.max_graph_bytes
              : consumedResources.max_query_bytes
          ),
        ],
        output.bytes.toString("base64")
      );
      witness.readback(name, output.bytes);
    }
    observe(["container", "rm", "--force", name], "unspecified removal\n");
    observe(
      ["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"],
      "\n"
    );
    witness.removal(name, true);
  };
  const listing = (part: string) =>
    container(
      ["find", "/opt/joern", "-type", "f", "-name", `io.joern.${part}-*.jar`, "-printf", "%f\\n"],
      `io.joern.${part}-4.0.627.jar\n${part === "joern-cli" ? "" : `io.joern.${part}-4.0.627-launcher.jar\n`}`
    );
  const measure = () => {
    newGroup();
    observe(
      ["version", "--format", "{{json .}}"],
      canonicalJson({ Client: { Version: "1.0.0" }, Server: { Version: "1.0.0" } })
    );
    image();
    listing("joern-cli");
    container(["which", "joern"], "/opt/joern/joern-cli/joern\n");
    container(["joern", "--help"], "Usage: joern [options] [<cpg.bin>]\n");
  };
  measure();
  newGroup();
  listing("php2cpg");
  listing("jssrc2cpg");
  for (const tool of ["java", "php", "python3"]) container([tool, "--version"], `${tool} 17.0.0\n`);
  measure();
  const cases: ScaP03InitialEvidenceV1["cases"] = [];
  for (const fixture of checked.fixtures) {
    newGroup();
    const graph = Buffer.from("unit graph, identical per language permitted");
    const inventory = Buffer.from(
      `META\t${Buffer.from(scaP03FrontendLanguageV1(fixture.language)).toString("base64")}\n${await pinnedInventory(fixture.path, (v) => Buffer.from(v).toString("base64"))}`
    );
    container(
      [
        "joern-parse",
        "--language",
        scaP03FrontendLanguageV1(fixture.language),
        "--output",
        "/work/graph.cpg.bin",
        "--max-num-def",
        String(consumedResources.max_num_def),
        "/source",
      ],
      "",
      "parse",
      { filename: "graph.cpg.bin", bytes: graph }
    );
    container(
      [
        "joern",
        "--script",
        "/scripts/inventory.sc",
        "--param",
        "cpgFile=/input/graph.cpg.bin",
        "--param",
        "outFile=/work/inventory.tsv",
      ],
      "",
      "inventory",
      { filename: "inventory.tsv", bytes: inventory }
    );
    const candidates = scaP03NativeQueryCandidatesV1(
      checked.query_release,
      parseScaP03NativeInventoryV1(inventory),
      [{ path: fixture.path, disposition: "parsed" }],
      consumedResources.max_query_items,
      { graph_component_sha256: sha256(graph), source_snapshot_sha256: fixture.content_sha256 },
      checked.corpus.expected_cases.filter((entry) => entry.language === fixture.language),
      m.source_oracle_validation_ref,
      Buffer.from(fixture.bytes).toString("utf8").split("\n")
    );
    for (const expected of checked.corpus.expected_cases.filter(
      (entry) => entry.language === fixture.language
    )) {
      const observations = projectScaP03OracleTargetObservationsV2(
        candidates.get(expected.query_id) ?? [],
        expected.oracle_assertions
      ).sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
      cases.push({
        case_id: expected.case_id,
        language: fixture.language,
        query_id: expected.query_id,
        frontend_language: scaP03FrontendLanguageV1(fixture.language),
        status: "passed",
        blocker_code: null,
        fixture_id: fixture.fixture_id,
        fixture_sha256: fixture.content_sha256,
        observations,
        observation_count: observations.length,
        observed_sha256: scaP03QualificationObservationSha256V2({
          fixture_id: fixture.fixture_id,
          fixture_sha256: fixture.content_sha256,
          query_id: expected.query_id,
          frontend_language: scaP03FrontendLanguageV1(fixture.language),
          release_sha256: checked.query_release.release_sha256,
          blocker_code: null,
          observations,
        }),
      });
    }
  }
  witness.finishWorkspace(true);
  const evidence: ScaP03InitialEvidenceV1 = {
    schema_id: "penny.sca-p03-initial-evidence.v1",
    schema_version: 1,
    run_id: f.run_id,
    invocation_nonce: proposal.invocation_nonce,
    request_sha256: directive.request_sha256,
    pre_live_inputs_ref: manifestRef,
    input_refs,
    status: "observed",
    predecessor_current_admission: "native_current_owner",
    measurement_scope: "deterministic_transport_test",
    query_release_sha256: checked.query_release.release_sha256,
    environment,
    cases,
    original_observations: observations,
    attempt_witness_base64: Buffer.from(witness.finalize("completed")).toString("base64"),
    cleanup: "owned_absence_observed",
    independent_review: "required",
    formal_qualification_granted: false,
    activation_granted: false,
    p04_dispatch_permitted: false,
  };
  const disposition = {
    outcome: "completed",
    remote_disposition: "proven_terminal",
    lease_disposition: "released",
    retryable: false,
    reason_code: null,
  } as const;
  const lease = {
    schema_version: 1 as const,
    lease_id: "unit-lease",
    backend_key_sha256: proposal.backend_resource_sha256,
    lease_epoch: 1,
    fencing_token_sha256: sha256("unit fence"),
  };
  const envelopes = (value = evidence): HostOperationCallRecordV1 => {
    const result = persist(
      "sca-p03-initial-evidence",
      evidence.schema_id,
      value,
      [
        ...new Map(
          [proposalRef, ...directive.input_artifacts.artifacts.map((v) => v.ref)].map((ref) => [
            ref.artifact_id,
            ref,
          ])
        ).values(),
      ],
      directive.state_id,
      `host:${declaration.adapter_id}`,
      `host-operation-specific-result:${initial.operation_record_id}`
    );
    const common = {
      schema_version: 1,
      operation_record_id: initial.operation_record_id,
      identity: directive.identity,
      state_id: directive.state_id,
      attempt: directive.attempt,
      operation_id: directive.operation_id,
      operation_kind: directive.operation_kind,
      registration_sha256: directive.registration_sha256,
      request_sha256: directive.request_sha256,
      disposition,
    };
    const platform = persist(
      "host-operation-result",
      "penny.host-operation-result.v1",
      { ...common, lease, operation_result_ref: result, output_artifacts: [] },
      [proposalRef, result],
      directive.state_id,
      "host:host-operation-owner",
      `host-operation-platform-result:${initial.operation_record_id}`
    );
    const ended = new Date().toISOString();
    const receipt = persist(
      "host-operation-receipt",
      "penny.host-operation-receipt.v1",
      {
        ...common,
        receipt_id: `hop_receipt_${sha256(canonicalJson({ operation_record_id: initial.operation_record_id, disposition_receipt_id: "unit-lease-receipt" }))}`,
        started_at: initial.started_at,
        ended_at: ended,
        progress_event_count: 0,
        poll_count: 0,
        request_bytes: proposalRef.byte_length,
        output_artifact_count: 1,
        output_bytes: result.byte_length,
        result_sha256: result.content_digest,
        remote_correlation_sha256: null,
        lease_disposition_receipt_id: "unit-lease-receipt",
      },
      [proposalRef, platform],
      directive.state_id,
      "host:host-operation-owner",
      `host-operation-receipt:${initial.operation_record_id}`
    );
    return validateHostOperationCallRecord({
      ...initial,
      lifecycle: "consumed",
      lease,
      lease_expires_at_ms: Date.now() + 60_000,
      disposition,
      fetched: {
        schema_version: 1,
        content_sha256: result.content_digest,
        byte_length: result.byte_length,
        item_count: 1,
        poll_count: 0,
      },
      persistence_plan: {
        schema_version: 1,
        operation_result: {
          schema_version: 1,
          operation_id: result.operation_id,
          version: 1,
          artifact_kind: result.kind,
          media_type: result.media_type,
          schema_id: evidence.schema_id,
          schema_version_required: 1,
          byte_length: result.byte_length,
          content_sha256: result.content_digest,
        },
        outputs: [],
        disposition,
      },
      operation_result_ref: result,
      platform_result_ref: platform,
      host_receipt_ref: receipt,
      lease_disposition_receipt_id: "unit-lease-receipt",
      updated_at: ended,
    });
  };
  const record = envelopes();
  return {
    store,
    checkpointer,
    binding,
    directive,
    declaration,
    proposal,
    evidence,
    record,
    checked,
    close: () => {
      checkpointer.close();
      store.close();
    },
  };
}
