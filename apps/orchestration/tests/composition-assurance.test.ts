import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
  OrchestrationService,
  canonicalJson,
  initializePennyState,
  prepareCompositionAssurance,
  materializeCompositionAssurance,
  validateCompositionAssurance,
  canonicalizeDefinitionRequest,
  type CompositionAdmissionInput,
  type ModelClient,
  type AgentCompletion,
  type AgentInvocation,
  type ArtifactRef,
  PLAN_START_ADMISSION,
  runtimeRegistrationSha256,
  skillContractSha256,
  CompositionAssuranceAdmissionError,
  validateDefineInvocation,
  validatePlanInvocation,
  assertSelectedSpecificationAssurance,
  ASSURANCE_LIMITS,
  validateContract,
  decisionRequestSha256,
  sealDecisionDraft,
  sha256,
  specificationStrategySourceItems,
  validateSpecification,
  validateStrategyV2,
  type StrategyCoreV2,
} from "../dist/index.js";
import {
  genericSpecificationFixture,
  genericDefinitionFrame,
  genericSpecificationCore,
  persistedSpecificationDraftV3,
} from "./fixtures/define-fixtures.js";
import {
  defineRequestConstraints,
  DefinitionRequestV1Schema,
  parseSpecificationDraftV3Candidate,
  persistedSpecificationDraftV3 as serializeSpecificationDraftV3,
  type DefinitionRequestV1,
} from "../dist/skill-contracts/define.js";
import { DEFINE_PLAYBOOK_REGISTRATION } from "../dist/playbooks/define.js";
import { bindGenericChildYamlAuthority, resolvePlaybook } from "../dist/playbooks/registry.js";

import { validateGroundedSynthesis } from "../dist/skill-contracts/research.js";
import { decisionDraft, decisionRequest } from "./fixtures/decision-fixtures.js";
import { persistEvidenceContext } from "./helpers/evidence-context.js";

const projectRoot = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function environment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), "penny-assurance-"));
  roots.push(root);
  const env = {
    ...process.env,
    PENNY_STATE_ROOT: path.join(root, "state"),
    PI_OBSERVABILITY_ENABLED: "false",
    PI_OBSERVABILITY_AUTO_START: "false",
  };
  initializePennyState(projectRoot, { env });
  return env;
}
const orientation = `Framed.\nSUMMARY:${canonicalJson({
  confidence: "CERTAIN",
  orientation_complete: true,
  gap_kind: "none",
  repair_owner: "none",
  selected_profile_id: "generic",
  profile_selection_basis: "Caller requested generic.",
  route: "author",
  route_reason: "No outstanding question.",
  clarification_questions: [],
  evidence_questions: [],
  findings: [],
  specification_delta: "Preserve all caller boundaries.",
})}`;
const pass = `Valid.\nSUMMARY:${canonicalJson({
  confidence: "CERTAIN",
  verdict: "PASS",
  gap_kind: "none",
  repair_owner: "none",
  findings: [],
  evidence: ["Exact source checked."],
  specification_delta: "No change required.",
})}`;
const approve = `Usable.\nSUMMARY:${canonicalJson({
  confidence: "CERTAIN",
  verdict: "APPROVE",
  gap_kind: "none",
  repair_owner: "none",
  findings: [],
  evidence: ["Latest specification checked."],
  specification_delta: "No revision required.",
})}`;
class Client implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  private count = 0;
  constructor(
    private readonly additional: readonly string[] = [],
    private readonly includeBase = true
  ) {}
  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    const fixture = genericSpecificationFixture();
    const output = [
      ...(this.includeBase
        ? [
            orientation,
            Buffer.from(persistedSpecificationDraftV3(fixture.draft)).toString("utf8"),
            pass,
            approve,
          ]
        : []),
      ...this.additional,
    ][this.count++];
    if (output === undefined) throw new Error("unexpected Define worker");
    return { text: output };
  }
}
function supportedDefineRegistrationSha256(): string {
  const registration = resolvePlaybook("define");
  if (registration === undefined) throw new Error("active Define registration is absent");
  return runtimeRegistrationSha256(bindGenericChildYamlAuthority(registration, projectRoot));
}
function admission(
  service: OrchestrationService,
  ref: CompositionAdmissionInput["specification_ref"],
  mode: CompositionAdmissionInput["mode"] = "reviewed_definition",
  runId = "future-consumer"
): CompositionAdmissionInput {
  return {
    artifacts: service.artifacts,
    checkpointer: service.checkpointer,
    project_id: service.config.projectId,
    project_root: projectRoot,
    supported_define_registration_sha256: supportedDefineRegistrationSha256(),
    consumer: {
      run_id: runId,
      registration_name: "plan",
      contract_sha256: "a".repeat(64),
      registration_sha256: "b".repeat(64),
    },
    invocation: {
      schema_version: 2,
      specification_assurance: mode,
      goal: "Make a plan",
      input_artifacts: ref === null ? [] : [ref],
    },
    request_bytes: canonicalJson({ goal: "Make a plan" }),
    request_schema: { schema_id: "penny.plan-request.v1", schema_version: 1 },
    specification_ref: ref,
    mode,
  };
}
async function completed(
  service: OrchestrationService,
  runId = "define-assurance-producer",
  request: DefinitionRequestV1 = genericSpecificationFixture().request,
  imports: readonly ArtifactRef[] = []
) {
  const terminal = await service.execute({
    schema_version: 2,
    action: "start",
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: runId,
      playbook: "define",
      engine_owner: "typescript",
    },
    goal: request.goal,
    constraints: defineRequestConstraints(request),
    input_artifacts: {
      schema_version: 2,
      artifacts: imports.map((ref, index) => ({ slot: `prior-skill-import-${index}`, ref })),
    },
    project_root: projectRoot,
    trust_profile: "hardened-untrusted",
  });
  if (terminal.action !== "complete" || !terminal.met)
    throw new Error(`Define ended ${terminal.action}`);
  const ref = terminal.artifacts.find((item) => item.kind === "specification");
  if (ref === undefined) throw new Error("Define omitted specification");
  return ref;
}
function service(env = environment()): OrchestrationService {
  return new OrchestrationService({
    projectRoot,
    env,
    modelClient: new Client(),
    playbookName: "define",
  });
}
// Public synthetic replay: the observed source produced a 17,436-byte specification,
// 15 selected artifacts, eight visits and four execution receipts, but 3,248 events
// (3,166 of them streaming progress). No live state, receipt keys or run bytes are imported.
function streamingDefinitionFixture() {
  return validateContract(
    Type.Object(
      {
        request: DefinitionRequestV1Schema,
        outputs: Type.Tuple([Type.String(), Type.String(), Type.String(), Type.String()]),
      },
      { additionalProperties: false }
    ),
    JSON.parse(
      readFileSync(new URL("./fixtures/define-streaming-assurance.json", import.meta.url), "utf8")
    ),
    "public synthetic streaming Define replay"
  );
}
function padTelemetry(owner: OrchestrationService, runId: string, eventCount: number): void {
  const count = owner.checkpointer.events(runId).length;
  for (let index = count; index < eventCount; index += 1) {
    owner.checkpointer.appendLivenessEvent(runId, "liveness_progress_observed", {
      schema_version: 1,
      activity_class: "message_delta",
      at_ms: 1_000 + index,
      observed_units: 1,
      worker_id: "synthetic-streaming-worker",
    });
  }
}
function assertNoProspectiveWrites(owner: OrchestrationService, runId: string): void {
  expect(owner.checkpointer.runExists(runId)).toBe(false);
  for (const kind of ["composition-request", "composition-assurance"]) {
    expect(
      owner.artifacts.refFor(runId, "admission", null, kind, `${kind}:${runId}`, 1)
    ).toBeNull();
  }
}
function mutationDatabase(owner: OrchestrationService) {
  const sqlite = process.getBuiltinModule("node:sqlite");
  if (sqlite === undefined) throw new Error("node:sqlite unavailable");
  return new sqlite.DatabaseSync(owner.checkpointer.dbPath);
}
// Deliberately bypass the public event writer's reserved-field protection, only in a disposable
// test store. Prefixes must never hide forged/malformed semantic evidence as harmless telemetry.
function appendForgedEvent(owner: OrchestrationService, runId: string, payload: string): void {
  using database = mutationDatabase(owner);
  database
    .prepare(
      `INSERT INTO events(run_id, sequence, event_type, payload_json, created_at)
       SELECT ?, COALESCE(MAX(sequence), 0) + 1, 'liveness_progress_observed', ?, ?
       FROM events WHERE run_id = ?`
    )
    .run(runId, payload, new Date().toISOString(), runId);
}

describe("project-bound composition assurance", () => {
  const planConstraints = {
    schema_version: 1 as const,
    desired_outcomes: ["A bounded next step."],
    current_state: { status: "provided" as const, facts: ["A specification exists."] },
    hard_constraints: [],
    non_goals: [],
    known_uncertainties: [],
    prior_decisions: [],
  };
  function planStart(
    runId: string,
    ref: ArtifactRef | null,
    policy: "reviewed_definition" | "semantic_only" | null
  ) {
    return {
      schema_version: 2 as const,
      action: "start" as const,
      identity: {
        schema_version: 2 as const,
        run_id: runId,
        session_id: runId,
        playbook: "plan",
        engine_owner: "typescript" as const,
      },
      goal: "Plan without execution.",
      constraints:
        policy === null
          ? planConstraints
          : {
              schema_version: 2,
              request: planConstraints,
              specification_assurance: policy,
            },
      project_root: projectRoot,
      trust_profile: "hardened-untrusted" as const,
      ...(ref === null
        ? {}
        : {
            input_artifacts: {
              schema_version: 2 as const,
              artifacts: [{ slot: "specification", ref }],
            },
          }),
    };
  }

  function importedEvidence(
    owner: OrchestrationService,
    kind: "grounded" | "decision" | "context"
  ) {
    if (kind === "context") return persistEvidenceContext(owner.artifacts, "assurance").ref;
    const fixture = validateContract(
      Type.Object({ grounded_synthesis: Type.Unknown() }),
      JSON.parse(
        readFileSync(
          new URL("./fixtures/skills/research/positive-vectors.json", import.meta.url),
          "utf8"
        )
      ),
      "research import fixture"
    );
    const request = decisionRequest();
    const content =
      kind === "grounded"
        ? validateGroundedSynthesis(fixture.grounded_synthesis)
        : sealDecisionDraft({
            request,
            draft: decisionDraft(),
            requestSha256: decisionRequestSha256(request),
            sourceRequestArtifactId: `art_${"e".repeat(64)}`,
            sourceDraftArtifactId: `art_${"f".repeat(64)}`,
            exactInputArtifactIds: [],
          });
    return owner.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: `imported-${kind}`,
        phase: "sealing_core",
        branch_id: null,
        kind: "semantic-core",
        operation_id: `imported-${kind}`,
        version: 1,
        producer: "host:test-semantic-import",
        media_type: "application/json",
        content_schema:
          kind === "grounded"
            ? { schema_id: "penny.grounded-synthesis.v1", schema_version: 1 }
            : { schema_id: "penny.decision.v2", schema_version: 2 },
        parent_ref: null,
        upstream_refs: [],
      },
      content: canonicalJson(content),
    });
  }

  it.each(["grounded", "decision", "context"] as const)(
    "completes the exact %s import → Define → strict Plan chain and replays its owner proof",
    async (kind) => {
      const env = environment();
      using owner = service(env);
      // Canonical native imports need not have a completed producer. Strict assurance attests
      // the completed Define graph and readable imported bytes, not reviewed import ancestry.
      const imported = importedEvidence(owner, kind);
      const fixture = genericSpecificationFixture();
      const request = canonicalizeDefinitionRequest({
        goal: fixture.request.goal,
        constraints: defineRequestConstraints(fixture.request),
        exactInputArtifactIds: [imported.artifact_id],
      });
      const draft = {
        ...fixture.draft,
        objectives: fixture.draft.objectives.map((entry) => ({
          ...entry,
          source_item_indexes: [...entry.source_item_indexes, 6],
        })),
        source_coverage: [
          ...fixture.draft.source_coverage,
          {
            source_item_index: 6,
            disposition: "incorporated" as const,
            rationale: "The exact imported semantic input informs the bounded objective.",
          },
        ],
      };
      const defineClient = new Client(
        [
          orientation,
          Buffer.from(persistedSpecificationDraftV3(draft, request)).toString("utf8"),
          pass,
          approve,
        ],
        false
      );
      let specificationRef: ArtifactRef;
      {
        using producer = new OrchestrationService({
          projectRoot,
          env,
          playbookName: "define",
          modelClient: defineClient,
        });
        specificationRef = await completed(producer, `define-import-${kind}`, request, [imported]);
        expect(producer.checkpointer.completionAdmission(specificationRef.run_id)).toBeDefined();
        const definition = producer.checkpointer.loadRunById(
          specificationRef.run_id
        )?.terminalDirective;
        expect(definition).toMatchObject({ action: "complete", status: "complete", met: true });
        if (definition?.action !== "complete") throw new Error("Define terminal missing");
        expect(definition.artifacts).toContainEqual(imported);
      }
      expect(defineClient.invocations.map((entry) => entry.stateId)).toEqual([
        "framing_definition",
        "authoring_specification",
        "verifying_specification",
        "critiquing_specification",
      ]);
      const specification = validateSpecification(
        JSON.parse(owner.artifacts.read(specificationRef).toString("utf8"))
      );
      const core: StrategyCoreV2 = {
        schema_version: 2,
        disposition: "ready",
        applicability_reason: "The reviewed definition supports a bounded plan.",
        outcomes: [
          {
            statement: "A bounded next step.",
            desired_outcome_indexes: [0],
            success_signal: "The reviewed requirements remain covered.",
          },
        ],
        dependencies: [],
        request_coverage: {
          current_state_fact_indexes: [0],
          input_artifact_slots: [0],
          hard_constraint_indexes: [],
          non_goal_indexes: [],
          uncertainty_indexes: [],
          prior_decision_indexes: [],
          blocked_desired_outcome_indexes: [],
        },
        blockers: [],
        confidence: "CERTAIN",
        source_item_coverage: specificationStrategySourceItems(specification).flatMap(
          (entry, index) =>
            entry.required
              ? [
                  {
                    source_item_index: index,
                    disposition: "addressed" as const,
                    strategy_outcome_indexes: [0],
                    rationale: "Preserve this reviewed source item.",
                  },
                ]
              : []
        ),
        unsupported_strategy_elements: [],
      };
      const summary = (details: Record<string, unknown>) =>
        `Report.\nSUMMARY:${canonicalJson({ confidence: "CERTAIN", gap_kind: "none", repair_owner: "none", findings: [], strategy_delta: "Preserve the reviewed definition.", ...details })}`;
      const client = new Client(
        [
          summary({ orientation_complete: true }),
          `Bounded strategy.\nSTRATEGY_CORE:${canonicalJson(core)}\nSUMMARY:{"confidence":"CERTAIN","complete":true}`,
          summary({ verdict: "PASS", evidence: ["Exact reviewed source checked."] }),
          summary({ verdict: "APPROVE", evidence: ["Latest strategy checked."] }),
        ],
        false
      );
      const runId = `strict-import-${kind}-plan`;
      let terminal;
      {
        using consumer = new OrchestrationService({
          projectRoot,
          env,
          playbookName: "plan",
          modelClient: client,
        });
        const start = planStart(runId, specificationRef, "reviewed_definition");
        terminal = await consumer.execute({
          ...start,
          input_artifacts: {
            schema_version: 2,
            artifacts: [{ slot: "previous-skill-terminal-output", ref: specificationRef }],
          },
        });
        expect(terminal).toMatchObject({ action: "complete", status: "complete", met: true });
        if (terminal.action !== "complete") throw new Error(`Plan ended ${terminal.action}`);
        const assuranceRef = terminal.artifacts.find((ref) => ref.kind === "composition-assurance");
        const strategyRef = terminal.artifacts.find((ref) => ref.kind === "strategy");
        if (assuranceRef === undefined || strategyRef === undefined)
          throw new Error("Plan graph is incomplete");
        const assurance = validateCompositionAssurance(
          JSON.parse(consumer.artifacts.read(assuranceRef).toString("utf8"))
        );
        expect(assurance).toMatchObject({
          mode: "reviewed_definition",
          specification_ref: specificationRef,
          producer: { run_id: specificationRef.run_id },
        });
        expect(assurance.checked_artifacts).toContainEqual({
          ref: imported,
          roles: ["imported_semantic_input"],
        });
        expect(
          validateStrategyV2(JSON.parse(consumer.artifacts.read(strategyRef).toString("utf8")))
            .execution_started
        ).toBe(false);
        expect(consumer.checkpointer.completionAdmission(runId)).toBeDefined();
      }
      expect(client.invocations.map((entry) => entry.stateId)).toEqual([
        "orienting_strategy",
        "strategizing",
        "verifying_strategy",
        "critiquing_strategy",
      ]);
      const noWorkers = new Client([], false);
      using reopened = new OrchestrationService({
        projectRoot,
        env,
        playbookName: "plan",
        modelClient: noWorkers,
      });
      expect(
        await reopened.execute({
          schema_version: 2,
          action: "recover",
          identity: terminal.identity,
        })
      ).toEqual(terminal);
      expect(noWorkers.invocations).toHaveLength(0);
    }
  );

  it.each([
    ["grounded", "imported-object"],
    ["decision", "imported-object"],
    ["grounded", "owner-receipt"],
    ["decision", "owner-receipt"],
  ] as const)(
    "refuses strict Plan after completed Define with %s import loses %s proof without writes, workers or downgrade",
    async (kind, corruption) => {
      const env = environment();
      using owner = service(env);
      const imported = importedEvidence(owner, kind);
      const fixture = genericSpecificationFixture();
      const request = canonicalizeDefinitionRequest({
        goal: fixture.request.goal,
        constraints: defineRequestConstraints(fixture.request),
        exactInputArtifactIds: [imported.artifact_id],
      });
      const draft = {
        ...fixture.draft,
        objectives: fixture.draft.objectives.map((entry) => ({
          ...entry,
          source_item_indexes: [...entry.source_item_indexes, 6],
        })),
        source_coverage: [
          ...fixture.draft.source_coverage,
          {
            source_item_index: 6,
            disposition: "incorporated" as const,
            rationale: "The exact imported semantic input informs the bounded objective.",
          },
        ],
      };
      const defineClient = new Client(
        [
          orientation,
          Buffer.from(persistedSpecificationDraftV3(draft, request)).toString("utf8"),
          pass,
          approve,
        ],
        false
      );
      let specificationRef: ArtifactRef;
      {
        using producer = new OrchestrationService({
          projectRoot,
          env,
          playbookName: "define",
          modelClient: defineClient,
        });
        specificationRef = await completed(
          producer,
          `define-negative-${kind}-${corruption}`,
          request,
          [imported]
        );
        expect(producer.checkpointer.completionAdmission(specificationRef.run_id)).toBeDefined();
        const terminal = producer.checkpointer.loadRunById(
          specificationRef.run_id
        )?.terminalDirective;
        expect(terminal).toMatchObject({ action: "complete", status: "complete", met: true });
        if (terminal?.action !== "complete") throw new Error("Define terminal missing");
        expect(terminal.artifacts).toContainEqual(imported);
      }
      expect(defineClient.invocations.map((entry) => entry.stateId)).toEqual([
        "framing_definition",
        "authoring_specification",
        "verifying_specification",
        "critiquing_specification",
      ]);
      const client = new Client([], false);
      using consumer = new OrchestrationService({
        projectRoot,
        env,
        playbookName: "plan",
        modelClient: client,
      });
      const runId = `strict-negative-${kind}-${corruption}`;
      const start = planStart(runId, specificationRef, "reviewed_definition");
      const assurance = {
        artifacts: consumer.artifacts,
        checkpointer: consumer.checkpointer,
        project_id: consumer.config.projectId,
        project_root: projectRoot,
        supported_define_registration_sha256: supportedDefineRegistrationSha256(),
        consumer: {
          run_id: runId,
          registration_name: "plan",
          contract_sha256: skillContractSha256(consumer.engine.registration.contract),
          registration_sha256: runtimeRegistrationSha256(consumer.engine.registration),
        },
      };
      const assertNoPlanWritesOrWorkers = () => {
        assertNoProspectiveWrites(consumer, runId);
        for (const artifactKind of ["plan-request", "plan-specification-source-index"]) {
          expect(
            consumer.artifacts.refFor(
              runId,
              "intake",
              null,
              artifactKind,
              `${artifactKind}:${sha256(runId).slice(0, 32)}`,
              1
            )
          ).toBeNull();
        }
        expect(client.invocations).toHaveLength(0);
      };
      // This positive preflight reaches the changed import-role boundary. Reverting the
      // runtime fix must fail here, not produce a false-green negative via UNSUPPORTED.
      const prepared = PLAN_START_ADMISSION.prepare(start, { assurance });
      const data = prepared.admission_data;
      if (typeof data !== "object" || data === null || !("assurance" in data))
        throw new Error("Plan assurance preflight missing");
      const proof = validateCompositionAssurance(data.assurance);
      expect(proof.mode).toBe("reviewed_definition");
      if (proof.mode !== "reviewed_definition") throw new Error("strict proof missing");
      expect(proof.specification_ref).toEqual(specificationRef);
      expect(proof.checked_artifacts).toContainEqual({
        ref: imported,
        roles: ["imported_semantic_input"],
      });
      assertNoPlanWritesOrWorkers();

      // Damage only the disposable store, after real Define completion and strict preflight.
      // Reuse the existing object-pruning and owner-database tamper seams; never reseal a product.
      if (corruption === "imported-object") {
        unlinkSync(
          path.join(
            owner.artifacts.root,
            "objects",
            "sha256",
            imported.content_digest.slice(0, 2),
            imported.content_digest.slice(2)
          )
        );
        expect(() => owner.artifacts.read(imported)).toThrow();
      } else {
        const receipt = proof.owner_evidence.find(
          (entry) => entry.record_class === "execution_receipt"
        );
        if (receipt === undefined) throw new Error("bound Define execution receipt missing");
        using database = mutationDatabase(owner);
        expect(
          database
            .prepare("UPDATE receipts SET result_json = '{}' WHERE run_id = ? AND receipt_id = ?")
            .run(receipt.run_id, receipt.coordinate).changes
        ).toBe(1);
      }
      const code =
        corruption === "imported-object"
          ? "SPECIFICATION_ASSURANCE_CUSTODY_INVALID"
          : "SPECIFICATION_ASSURANCE_BINDING_INVALID";
      // A separate explicit semantic-only preflight still accepts the unaltered canonical
      // specification. Strict admission must not silently choose that weaker policy.
      expect(
        prepareCompositionAssurance(
          admission(owner, specificationRef, "semantic_only", `semantic-control-${runId}`)
        )
      ).toMatchObject({ status: "prepared", assurance: { mode: "semantic_only" } });
      expect(() =>
        PLAN_START_ADMISSION.materialize(prepared, {
          run_id: runId,
          artifactStore: consumer.artifacts,
          assurance,
        })
      ).toThrow(code);
      assertNoPlanWritesOrWorkers();
      await expect(consumer.execute(start)).rejects.toMatchObject({
        refusal: { code, requested_mode: "reviewed_definition" },
      });
      assertNoPlanWritesOrWorkers();
    }
  );

  it("refuses unsupported import kind/schema/version, malformed bytes and stale refs before Define writes or workers", () => {
    const client = new Client([], false);
    using owner = new OrchestrationService({
      projectRoot,
      env: environment(),
      playbookName: "define",
      modelClient: client,
    });
    const real = importedEvidence(owner, "grounded");
    const metadata = owner.artifacts.metadata(real);
    const { content_schema: schema, ...untypedMetadata } = metadata;
    if (schema === undefined) throw new Error("typed import metadata missing");
    const invalid = [
      {
        kind: "semantic-core",
        content_schema: { schema_id: "penny.assessment.v2", schema_version: 2 },
      },
      {
        kind: "semantic-core",
        content_schema: { schema_id: "penny.grounded-synthesis.v1", schema_version: 2 },
      },
      {
        kind: "semantic-core",
        content_schema: { schema_id: "penny.decision.v1", schema_version: 1 },
      },
      {
        kind: "semantic-core",
        content_schema: { schema_id: "penny.decision.v2", schema_version: 1 },
      },
      { kind: "research-product-envelope", content_schema: schema },
      {
        kind: "evidence-context",
        content_schema: { schema_id: "penny.evidence-context.v1", schema_version: 2 },
      },
      { kind: "semantic-core" },
    ];
    const refs = invalid.map((patch, index) =>
      owner.artifacts.persist({
        metadata: { ...untypedMetadata, ...patch, operation_id: `unsupported-import-${index}` },
        content: owner.artifacts.read(real),
      })
    );
    refs.push(
      owner.artifacts.persist({
        metadata: { ...metadata, operation_id: "malformed-import" },
        content: "{}",
      })
    );
    refs.push({ ...real, content_digest: "0".repeat(64) });
    for (const [index, ref] of refs.entries()) {
      const runId = `invalid-import-${index}`;
      const request = genericSpecificationFixture().request;
      expect(() =>
        owner.engine.handle({
          schema_version: 2,
          action: "start",
          identity: {
            schema_version: 2,
            run_id: runId,
            session_id: runId,
            playbook: "define",
            engine_owner: "typescript",
          },
          goal: request.goal,
          constraints: defineRequestConstraints(request),
          project_root: projectRoot,
          trust_profile: "hardened-untrusted",
          input_artifacts: {
            schema_version: 2,
            artifacts: [{ slot: "previous-skill-terminal-output", ref }],
          },
        })
      ).toThrow(
        index < invalid.length
          ? "COMPOSITION_PORT_UNMATCHED"
          : index === invalid.length
            ? "COMPOSITION_SEMANTIC_INVALID"
            : "COMPOSITION_ARTIFACT_STALE"
      );
      assertNoProspectiveWrites(owner, runId);
      expect(
        owner.artifacts.refFor(
          runId,
          "intake",
          null,
          "definition-request",
          `definition-request:${sha256(runId).slice(0, 32)}`,
          1
        )
      ).toBeNull();
    }
    expect(client.invocations).toHaveLength(0);
  });

  it("closes both invocation wrappers and maps legacy constraints only to semantic-only", () => {
    const define = defineRequestConstraints(genericSpecificationFixture().request);
    for (const [validator, request] of [
      [validateDefineInvocation, define],
      [validatePlanInvocation, planConstraints],
    ] as const) {
      expect(validator(request)).toMatchObject({ specification_assurance: "semantic_only" });
      expect(
        validator({ schema_version: 2, request, specification_assurance: "reviewed_definition" })
      ).toMatchObject({ specification_assurance: "reviewed_definition" });
      for (const invalid of [
        { ...request, unexpected: true },
        { ...request, schema_version: 3 },
        { schema_version: 2, request, specification_assurance: "semantic_only", unexpected: true },
        {
          schema_version: 2,
          request: { ...request, unexpected: true },
          specification_assurance: "semantic_only",
        },
        { schema_version: 2, request, specification_assurance: "not_applicable" },
      ])
        expect(() => validator(invalid)).toThrow();
    }
  });
  it("admits V1 and explicit V2 semantic-only and durable no-spec, but refuses unsupported invocation shapes", async () => {
    const env = environment();
    using producer = service(env);
    const spec = await completed(producer);
    using consumer = new OrchestrationService({
      projectRoot,
      env,
      playbookName: "plan",
      modelClient: new Client([], false),
    });
    for (const [runId, policy, expected] of [
      ["plan-v1-semantic", null, "semantic_only"],
      ["plan-v2-semantic", "semantic_only", "semantic_only"],
      ["plan-v2-absent", "reviewed_definition", "not_applicable"],
    ] as const) {
      const directive = consumer.engine.handle(
        planStart(runId, runId.endsWith("absent") ? null : spec, policy)
      );
      expect(directive.action).toBe("invoke_agent");
      const assuranceRef = consumer.checkpointer
        .loadRunById(runId)
        ?.selectedArtifacts.find((ref) => ref.kind === "composition-assurance");
      if (assuranceRef === undefined) throw new Error("start omitted durable assurance");
      expect(
        validateCompositionAssurance(
          JSON.parse(consumer.artifacts.read(assuranceRef).toString("utf8"))
        )
      ).toMatchObject({ mode: expected });
    }
    for (const [runId, constraints] of [
      ["plan-unknown-version", { ...planConstraints, schema_version: 3 }],
      [
        "plan-extra-field",
        {
          schema_version: 2,
          request: planConstraints,
          specification_assurance: "reviewed_definition",
          extra: true,
        },
      ],
      [
        "plan-unknown-policy",
        { schema_version: 2, request: planConstraints, specification_assurance: "something_else" },
      ],
    ] as const) {
      expect(() =>
        consumer.engine.handle({ ...planStart(runId, spec, null), constraints })
      ).toThrow();
      expect(consumer.checkpointer.runExists(runId)).toBe(false);
    }
  });

  it("strict starts refuse synthetic, wrong-project and unfinished sources without runs or workers", async () => {
    const env = environment();
    using producer = service(env);
    const real = await completed(producer);
    using consumer = new OrchestrationService({
      projectRoot,
      env,
      playbookName: "plan",
      modelClient: new Client([], false),
    });
    const synthetic = producer.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: "uncommitted-definition",
        phase: "sealing_specification",
        branch_id: null,
        kind: "specification",
        operation_id: "uncommitted",
        version: 1,
        producer: "host:specification-sealer",
        media_type: "application/json",
        content_schema: { schema_id: "penny.specification.v1", schema_version: 1 },
        parent_ref: null,
        upstream_refs: [],
      },
      content: producer.artifacts.read(real),
    });
    expect(
      consumer.engine.handle(planStart("explicit-synthetic-semantic", synthetic, "semantic_only"))
        .action
    ).toBe("invoke_agent");
    const semanticRef = consumer.checkpointer
      .loadRunById("explicit-synthetic-semantic")
      ?.selectedArtifacts.find((ref) => ref.kind === "composition-assurance");
    if (semanticRef === undefined) throw new Error("explicit semantic-only assurance missing");
    expect(
      validateCompositionAssurance(
        JSON.parse(consumer.artifacts.read(semanticRef).toString("utf8"))
      )
    ).toMatchObject({ mode: "semantic_only", producer: null });
    const unfinishedId = "unfinished-definition";
    producer.engine.handle({
      schema_version: 2,
      action: "start",
      identity: {
        schema_version: 2,
        run_id: unfinishedId,
        session_id: unfinishedId,
        playbook: "define",
        engine_owner: "typescript",
      },
      goal: genericSpecificationFixture().request.goal,
      constraints: defineRequestConstraints(genericSpecificationFixture().request),
      project_root: projectRoot,
      trust_profile: "hardened-untrusted",
    });
    const unfinished = producer.artifacts.persist({
      metadata: {
        ...producer.artifacts.metadata(synthetic),
        run_id: unfinishedId,
        operation_id: "unfinished",
      },
      content: producer.artifacts.read(real),
    });
    using foreign = service();
    const foreignSpec = await completed(foreign, "foreign-definition");
    for (const [runId, ref, code] of [
      ["strict-synthetic", synthetic, "SPECIFICATION_ASSURANCE_UNAVAILABLE"],
      ["strict-unfinished", unfinished, "SPECIFICATION_ASSURANCE_NOT_COMPLETE"],
      ["strict-foreign", foreignSpec, "SPECIFICATION_ASSURANCE_UNAVAILABLE"],
    ] as const) {
      try {
        consumer.engine.handle(planStart(runId, ref, "reviewed_definition"));
        throw new Error("strict start unexpectedly succeeded");
      } catch (error) {
        expect(error).toBeInstanceOf(CompositionAssuranceAdmissionError);
        if (error instanceof CompositionAssuranceAdmissionError)
          expect(error.refusal.code).toBe(code);
      }
      expect(consumer.checkpointer.runExists(runId)).toBe(false);
    }
  });

  it("adopts exact orphaned prospective slots and refuses changed policy conflicts before run creation", async () => {
    const env = environment();
    using producer = service(env);
    const spec = await completed(producer);
    using consumer = new OrchestrationService({
      projectRoot,
      env,
      playbookName: "plan",
      modelClient: new Client([], false),
    });
    const assurance = {
      artifacts: consumer.artifacts,
      checkpointer: consumer.checkpointer,
      project_id: consumer.config.projectId,
      project_root: projectRoot,
      supported_define_registration_sha256: supportedDefineRegistrationSha256(),
      consumer: {
        run_id: "plan-orphan",
        registration_name: "plan",
        contract_sha256: skillContractSha256(consumer.engine.registration.contract),
        registration_sha256: runtimeRegistrationSha256(consumer.engine.registration),
      },
    };
    const request = planStart("plan-orphan", spec, "reviewed_definition");
    const prepared = PLAN_START_ADMISSION.prepare(request, { assurance });
    const refs = PLAN_START_ADMISSION.materialize(prepared, {
      run_id: "plan-orphan",
      artifactStore: consumer.artifacts,
      assurance,
    });
    expect(refs.map((ref) => ref.kind)).toEqual([
      "plan-request",
      "plan-specification-source-index",
      "composition-assurance",
    ]);
    expect(consumer.checkpointer.runExists("plan-orphan")).toBe(false);
    expect(() => consumer.engine.handle(planStart("plan-orphan", spec, "semantic_only"))).toThrow(
      "SPECIFICATION_ASSURANCE_BINDING_INVALID"
    );
    expect(consumer.checkpointer.runExists("plan-orphan")).toBe(false);
    expect(consumer.engine.handle(request).action).toBe("invoke_agent");
    expect(() => consumer.engine.handle(planStart("plan-orphan", spec, "semantic_only"))).toThrow(
      "cannot be started again"
    );
  });
  it("revises a completed Define under reviewed-definition policy and seals that exact parent assurance", async () => {
    const env = environment();
    using producer = service(env);
    const priorRef = await completed(producer);
    const fixture = genericSpecificationFixture();
    const constraints = { ...defineRequestConstraints(fixture.request), mode: "revise" as const };
    const request = canonicalizeDefinitionRequest({
      goal: fixture.request.goal,
      constraints,
      exactInputArtifactIds: [priorRef.artifact_id],
    });
    const core = genericSpecificationCore(genericDefinitionFrame(request));
    const draft = {
      ...core,
      specification_report: "This full revision preserves the prior source boundary.",
      objectives: core.objectives.map((entry, index) =>
        index === 0 ? { ...entry, source_item_indexes: [...entry.source_item_indexes, 6] } : entry
      ),
      source_coverage: [
        ...core.source_coverage,
        {
          source_item_index: 6,
          disposition: "incorporated" as const,
          product_item_refs: [{ kind: "objective" as const, index: 0 }],
          rationale: "The completed immediate parent anchors this revision.",
        },
      ],
    };
    const outputs = [
      orientation,
      Buffer.from(
        persistedSpecificationDraftV3(
          { ...draft, source_coverage: draft.source_coverage.slice(0, -1) },
          request
        )
      ).toString("utf8"),
      Buffer.from(persistedSpecificationDraftV3(draft, request)).toString("utf8"),
      pass,
      approve,
    ];
    using reviser = new OrchestrationService({
      projectRoot,
      env,
      playbookName: "define",
      modelClient: new Client(outputs, false),
    });
    const runId = "reviewed-define-revision";
    const terminal = await reviser.execute({
      schema_version: 2,
      action: "start",
      identity: {
        schema_version: 2,
        run_id: runId,
        session_id: runId,
        playbook: "define",
        engine_owner: "typescript",
      },
      goal: request.goal,
      constraints: {
        schema_version: 2,
        request: constraints,
        specification_assurance: "reviewed_definition",
      },
      project_root: projectRoot,
      trust_profile: "hardened-untrusted",
      input_artifacts: {
        schema_version: 2,
        artifacts: [{ slot: "prior-specification", ref: priorRef }],
      },
    });
    if (terminal.action !== "complete") throw new Error(`revision ended ${terminal.action}`);
    const assuranceRef = terminal.artifacts.find((item) => item.kind === "composition-assurance");
    const integrityRef = terminal.artifacts.find(
      (item) => item.kind === "specification-product-integrity"
    );
    const envelopeRef = terminal.artifacts.find(
      (item) => item.kind === "specification-product-envelope"
    );
    if (assuranceRef === undefined || integrityRef === undefined || envelopeRef === undefined)
      throw new Error("reviewed revision graph is incomplete");
    expect(
      validateCompositionAssurance(
        JSON.parse(reviser.artifacts.read(assuranceRef).toString("utf8"))
      )
    ).toMatchObject({
      mode: "reviewed_definition",
      specification_ref: priorRef,
      producer: { run_id: priorRef.run_id },
    });
    expect(JSON.parse(reviser.artifacts.read(integrityRef).toString("utf8"))).toMatchObject({
      specification_assurance_ref: assuranceRef,
    });
    expect(JSON.parse(reviser.artifacts.read(envelopeRef).toString("utf8"))).toMatchObject({
      specification_assurance_ref: assuranceRef,
    });
    expect(reviser.checkpointer.completionAdmission(runId)).toBeDefined();
  });
  it("admits a real stage-3 completed Define and adopts identical prospective artifacts without creating a run", async () => {
    using owner = service();
    const ref = await completed(owner);
    const input = admission(owner, ref);
    const result = prepareCompositionAssurance(input);
    expect(result).toMatchObject({ status: "prepared" });
    if (result.status !== "prepared") return;
    expect(result.assurance.mode).toBe("reviewed_definition");
    if (result.assurance.mode !== "reviewed_definition") throw new Error("reviewed mode missing");
    expect(result.assurance.checked_artifacts.map((item) => item.roles).flat()).toContain("trace");
    expect(result.assurance.owner_evidence.length).toBeGreaterThan(0);
    expect(result.assurance.checked_artifact_bytes).toBeLessThan(64 * 1024 * 1024);
    expect(result.assurance.owner_evidence.length).toBeLessThan(128);
    expect(validateCompositionAssurance(result.assurance)).toEqual(result.assurance);
    expect(
      prepareCompositionAssurance({
        ...input,
        supported_define_registration_sha256: "f".repeat(64),
      })
    ).toMatchObject({ status: "refused", code: "SPECIFICATION_ASSURANCE_UNSUPPORTED" });
    const first = materializeCompositionAssurance(input, result.assurance);
    expect(first.status).toBe("materialized");
    expect(materializeCompositionAssurance(input, result.assurance)).toEqual(first);
    expect(owner.checkpointer.runExists(input.consumer.run_id)).toBe(false);
    expect(
      prepareCompositionAssurance({ ...input, request_bytes: canonicalJson({ goal: "Changed" }) })
        .status
    ).toBe("prepared");
    const changed = prepareCompositionAssurance({
      ...input,
      request_bytes: canonicalJson({ goal: "Changed" }),
    });
    if (changed.status !== "prepared") throw new Error("changed preflight missing");
    expect(
      materializeCompositionAssurance(
        { ...input, request_bytes: canonicalJson({ goal: "Changed" }) },
        changed.assurance
      )
    ).toMatchObject({ status: "refused", code: "SPECIFICATION_ASSURANCE_BINDING_INVALID" });
    const alteredPolicy = {
      ...input,
      invocation: {
        schema_version: 2,
        specification_assurance: "reviewed_definition",
        goal: "Different goal",
        input_artifacts: [ref],
      },
    };
    const changedAssurance = prepareCompositionAssurance(alteredPolicy);
    if (changedAssurance.status !== "prepared")
      throw new Error("changed assurance preflight missing");
    expect(
      materializeCompositionAssurance(alteredPolicy, changedAssurance.assurance)
    ).toMatchObject({
      status: "refused",
      code: "SPECIFICATION_ASSURANCE_BINDING_INVALID",
    });
  });
  it.each(["observed", "larger"] as const)(
    "admits the %s reviewed source independently of streaming event count, including continuing custody",
    async (size) => {
      const fixture = streamingDefinitionFixture();
      const outputs = [...fixture.outputs];
      if (size === "larger") {
        const { draft } = parseSpecificationDraftV3Candidate(Buffer.from(fixture.outputs[1]));
        outputs[1] = Buffer.from(
          serializeSpecificationDraftV3({
            ...draft,
            specification_report: `${draft.specification_report}\n${"Public synthetic notice context. ".repeat(1_600)}`,
          })
        ).toString("utf8");
      }
      const env = environment();
      using owner = new OrchestrationService({
        projectRoot,
        env,
        playbookName: "define",
        modelClient: new Client(outputs, false),
      });
      const ref = await completed(owner, `streaming-${size}-producer`, fixture.request);
      if (size === "observed") expect(ref.byte_length).toBe(17_436);
      else expect(ref.byte_length).toBeGreaterThan(64 * 1024);
      const input = admission(owner, ref);
      const original = prepareCompositionAssurance(input);
      if (original.status !== "prepared" || original.assurance.mode !== "reviewed_definition")
        throw new Error(`synthetic source did not prepare: ${canonicalJson(original)}`);
      expect(original.assurance.checked_artifact_count).toBe(15);
      expect(original.assurance.owner_evidence).toHaveLength(14);
      for (const count of [128, 3_248, 8_192]) {
        padTelemetry(owner, ref.run_id, count);
        expect(owner.checkpointer.events(ref.run_id)).toHaveLength(count);
        // The existing raw-record reader would refuse; admission must budget actual proof,
        // not weaken that reader or let progress manufacture new assurance evidence.
        expect(() => owner.checkpointer.compositionEvidence(ref.run_id)).toThrow(
          "SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED"
        );
        expect(prepareCompositionAssurance(input)).toEqual(original);
        assertNoProspectiveWrites(owner, input.consumer.run_id);
      }
      const prepared = materializeCompositionAssurance(input, original.assurance);
      expect(prepared.status).toBe("materialized");
      expect(materializeCompositionAssurance(input, original.assurance)).toEqual(prepared);
      expect(owner.checkpointer.runExists(input.consumer.run_id)).toBe(false);
      using consumer = new OrchestrationService({
        projectRoot,
        env,
        playbookName: "plan",
        modelClient: new Client([], false),
      });
      const runId = `streaming-${size}-plan`;
      expect(consumer.engine.handle(planStart(runId, ref, "reviewed_definition")).action).toBe(
        "invoke_agent"
      );
      const context = consumer.checkpointer.loadRunById(runId);
      const native = context?.selectedArtifacts.find((item) => item.kind === "plan-request");
      if (context === undefined || native === undefined) throw new Error("Plan admission absent");
      const assuranceRef = assertSelectedSpecificationAssurance({
        context,
        reader: consumer.artifacts,
        checkpointer: consumer.checkpointer,
        native_request_ref: native,
        imported_input_refs: [ref],
      });
      expect(
        validateCompositionAssurance(JSON.parse(consumer.artifacts.read(assuranceRef).toString()))
      ).toMatchObject({
        mode: "reviewed_definition",
        consumer: {
          run_id: runId,
          registration_sha256: runtimeRegistrationSha256(consumer.engine.registration),
        },
        producer: { run_id: ref.run_id },
        specification_ref: ref,
        checked_artifacts: original.assurance.checked_artifacts,
        owner_evidence: original.assurance.owner_evidence,
      });
    }
  );

  it("retains the raw UTF-8 owner byte ceiling before decoding malformed oversized records", async () => {
    using owner = service();
    const ref = await completed(owner);
    padTelemetry(owner, ref.run_id, 128);
    const input = admission(owner, ref);
    const prepared = prepareCompositionAssurance(input);
    if (prepared.status !== "prepared") throw new Error("bounded telemetry did not prepare");
    // Less than 16 Mi characters, but more than 16 MiB. This malformed record must be charged
    // before JSON parsing, which would instead classify it as invalid custody.
    appendForgedEvent(owner, ref.run_id, `{${"é".repeat(ASSURANCE_LIMITS.recordBytes / 2)}`);
    expect(prepareCompositionAssurance(input)).toMatchObject({
      status: "refused",
      code: "SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED",
    });
    expect(materializeCompositionAssurance(input, prepared.assurance)).toMatchObject({
      status: "refused",
      code: "SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED",
    });
    assertNoProspectiveWrites(owner, input.consumer.run_id);
  });

  it("still bounds the complete semantic proof inventory instead of physical events", async () => {
    using owner = service();
    const ref = await completed(owner);
    const input = admission(owner, ref);
    const prepared = prepareCompositionAssurance(input);
    if (prepared.status !== "prepared") throw new Error("source did not prepare");
    for (let index = 0; index < 4; index += 1) {
      appendForgedEvent(
        owner,
        ref.run_id,
        canonicalJson({
          state_visits_v1: Array.from({ length: 32 }, () => ({
            schema_version: 1,
            source: "transition",
            state_id: "authoring_specification",
          })),
        })
      );
    }
    expect(prepareCompositionAssurance(input)).toMatchObject({
      status: "refused",
      code: "SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED",
    });
    expect(materializeCompositionAssurance(input, prepared.assurance)).toMatchObject({
      status: "refused",
      code: "SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED",
    });
    assertNoProspectiveWrites(owner, input.consumer.run_id);
  });

  it.each(["malformed", "visit", "admission", "receipt"] as const)(
    "does not hide %s evidence inside a large telemetry inventory or create a refused Plan",
    async (corruption) => {
      const env = environment();
      using owner = service(env);
      const ref = await completed(owner);
      padTelemetry(owner, ref.run_id, 128);
      const input = admission(owner, ref);
      const prepared = prepareCompositionAssurance(input);
      if (prepared.status !== "prepared") throw new Error("bounded source did not prepare");
      using consumer = new OrchestrationService({
        projectRoot,
        env,
        playbookName: "plan",
        modelClient: new Client([], false),
      });
      const boundRunId = `bound-streaming-${corruption}-plan`;
      expect(consumer.engine.handle(planStart(boundRunId, ref, "reviewed_definition")).action).toBe(
        "invoke_agent"
      );
      const context = consumer.checkpointer.loadRunById(boundRunId);
      const native = context?.selectedArtifacts.find((item) => item.kind === "plan-request");
      if (context === undefined || native === undefined) throw new Error("Plan admission absent");
      const continuing = () =>
        assertSelectedSpecificationAssurance({
          context,
          reader: consumer.artifacts,
          checkpointer: consumer.checkpointer,
          native_request_ref: native,
          imported_input_refs: [ref],
        });
      expect(continuing).not.toThrow();
      if (corruption === "receipt") {
        const receipt = owner.checkpointer.completionAdmission(ref.run_id)?.evidence_refs[0];
        if (receipt === undefined) throw new Error("execution receipt missing");
        using database = mutationDatabase(owner);
        database
          .prepare("UPDATE receipts SET result_json = '{}' WHERE run_id = ? AND receipt_id = ?")
          .run(ref.run_id, receipt.reference_id);
      } else {
        const payload =
          corruption === "malformed"
            ? "{"
            : corruption === "admission"
              ? canonicalJson({
                  completion_admission_v1: owner.checkpointer.completionAdmission(ref.run_id),
                })
              : canonicalJson({
                  state_visits_v1: [
                    { schema_version: 1, source: "transition", state_id: "intake" },
                  ],
                });
        appendForgedEvent(owner, ref.run_id, payload);
      }
      const result = prepareCompositionAssurance(input);
      expect(result.status).toBe("refused");
      if (result.status !== "refused") throw new Error("corrupt proof unexpectedly admitted");
      expect(result.code).toBe(
        corruption === "malformed" || corruption === "admission"
          ? "SPECIFICATION_ASSURANCE_CUSTODY_INVALID"
          : "SPECIFICATION_ASSURANCE_BINDING_INVALID"
      );
      expect(materializeCompositionAssurance(input, prepared.assurance)).toMatchObject({
        status: "refused",
        code: result.code,
      });
      assertNoProspectiveWrites(owner, input.consumer.run_id);
      expect(continuing).toThrow();
      const runId = `refused-streaming-${corruption}-plan`;
      expect(() => consumer.engine.handle(planStart(runId, ref, "reviewed_definition"))).toThrow(
        result.code
      );
      assertNoProspectiveWrites(consumer, runId);
    }
  );

  it("refuses a completed producer whose exact runtime registration is unsupported", async () => {
    const sealPolicy = DEFINE_PLAYBOOK_REGISTRATION.seal_policy;
    if (sealPolicy === undefined) throw new Error("Define seal policy is absent");
    using producer = new OrchestrationService({
      projectRoot,
      env: environment(),
      modelClient: new Client(),
      playbookRegistration: {
        ...DEFINE_PLAYBOOK_REGISTRATION,
        seal_policy: { ...sealPolicy, correction_limit: 1 },
      },
    });
    const ref = await completed(producer, "define-unsupported-registration");
    expect(prepareCompositionAssurance(admission(producer, ref))).toMatchObject({
      status: "refused",
      code: "SPECIFICATION_ASSURANCE_UNSUPPORTED",
    });
  });

  it("labels canonical semantic-only and absent inputs without claiming producer evidence", async () => {
    using owner = service();
    const ref = await completed(owner);
    const semantic = prepareCompositionAssurance(admission(owner, ref, "semantic_only"));
    expect(semantic).toMatchObject({
      status: "prepared",
      assurance: { mode: "semantic_only", scope: ["canonical_semantics"], producer: null },
    });
    if (semantic.status !== "prepared") throw new Error("semantic assurance missing");
    const checked = semantic.assurance.checked_artifacts[0];
    if (checked === undefined) throw new Error("canonical semantic ref missing");
    expect(() =>
      validateCompositionAssurance({
        ...semantic.assurance,
        checked_artifacts: Array.from({ length: 257 }, () => checked),
        checked_artifact_count: 257,
      })
    ).toThrow();
    expect(() =>
      validateCompositionAssurance({
        ...semantic.assurance,
        checked_artifact_bytes: 64 * 1024 * 1024 + 1,
      })
    ).toThrow();
    expect(() =>
      validateCompositionAssurance({
        ...semantic.assurance,
        consumer: { ...semantic.assurance.consumer, run_id: "x".repeat(1024 * 1024) },
      })
    ).toThrow("SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED");
    expect(prepareCompositionAssurance(admission(owner, null, "not_applicable"))).toMatchObject({
      status: "prepared",
      assurance: { mode: "not_applicable", checked_artifacts: [] },
    });
    expect(prepareCompositionAssurance(admission(owner, null))).toMatchObject({
      status: "refused",
      code: "SPECIFICATION_ASSURANCE_BINDING_INVALID",
    });
  });
  it("refuses synthetic products without a committed owner and bounds exact owner record reads", async () => {
    using owner = service();
    const real = await completed(owner);
    const canonical = owner.artifacts.read(real).toString("utf8");
    const synthetic = owner.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: "synthetic-uncommitted-define",
        phase: "sealing_specification",
        branch_id: null,
        kind: "specification",
        operation_id: "synthetic",
        version: 1,
        producer: "host:synthetic",
        media_type: "application/json",
        content_schema: { schema_id: "penny.specification.v1", schema_version: 1 },
        parent_ref: null,
        upstream_refs: [],
      },
      content: canonical,
    });
    expect(prepareCompositionAssurance(admission(owner, synthetic))).toMatchObject({
      status: "refused",
      code: "SPECIFICATION_ASSURANCE_UNAVAILABLE",
    });
    const fixture = genericSpecificationFixture();
    const unfinishedId = "synthetic-unfinished-define";
    owner.engine.handle({
      schema_version: 2,
      action: "start",
      identity: {
        schema_version: 2,
        run_id: unfinishedId,
        session_id: unfinishedId,
        playbook: "define",
        engine_owner: "typescript",
      },
      goal: fixture.request.goal,
      constraints: defineRequestConstraints(fixture.request),
      project_root: projectRoot,
      trust_profile: "hardened-untrusted",
    });
    const unfinished = owner.artifacts.persist({
      metadata: {
        ...owner.artifacts.metadata(synthetic),
        run_id: unfinishedId,
        operation_id: "synthetic-unfinished",
      },
      content: canonical,
    });
    expect(prepareCompositionAssurance(admission(owner, unfinished))).toMatchObject({
      status: "refused",
      code: "SPECIFICATION_ASSURANCE_NOT_COMPLETE",
    });
    expect(prepareCompositionAssurance(admission(owner, synthetic, "semantic_only"))).toMatchObject(
      {
        status: "prepared",
        assurance: { mode: "semantic_only" },
      }
    );
    expect(() => owner.checkpointer.compositionEvidence(real.run_id, 1)).toThrow(
      "SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED"
    );
    expect(() => owner.checkpointer.compositionEvidence(real.run_id, 128, 1)).toThrow(
      "SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED"
    );
    expect(
      prepareCompositionAssurance({
        ...admission(owner, real),
        invocation: { oversized: "x".repeat(1024 * 1024) },
      })
    ).toMatchObject({
      status: "refused",
      code: "SPECIFICATION_ASSURANCE_LIMIT_EXCEEDED",
    });
    expect(owner.checkpointer.runExists("future-consumer")).toBe(false);
  });
  it("checks only the actual immediate prior product of a completed Define revision", async () => {
    const prior = genericSpecificationFixture();
    const priorMetadata = {
      schema_version: 2 as const,
      run_id: "canonical-standalone-prior",
      phase: "sealing_specification",
      branch_id: null,
      kind: "specification",
      operation_id: "canonical-prior",
      version: 1,
      producer: "host:specification-sealer",
      media_type: "application/json",
      content_schema: { schema_id: "penny.specification.v1", schema_version: 1 },
      parent_ref: null,
      upstream_refs: [],
    };
    // This canonical immediate parent has no producer run. Strict revision checks closure,
    // not complete reviewed ancestry.
    const constraints = { ...defineRequestConstraints(prior.request), mode: "revise" as const };
    const draftFor = (priorId: string) => {
      const request = canonicalizeDefinitionRequest({
        goal: prior.request.goal,
        constraints,
        exactInputArtifactIds: [priorId],
      });
      const core = genericSpecificationCore(genericDefinitionFrame(request));
      const draft = {
        ...core,
        specification_report: "This complete revision retains the source's requirements.",
        objectives: core.objectives.map((entry, index) =>
          index === 0 ? { ...entry, source_item_indexes: [...entry.source_item_indexes, 6] } : entry
        ),
        source_coverage: [
          ...core.source_coverage,
          {
            source_item_index: 6,
            disposition: "incorporated" as const,
            product_item_refs: [{ kind: "objective" as const, index: 0 }],
            rationale: "The immediate parent anchors this revision.",
          },
        ],
      };
      return { request, draft };
    };
    const outputs: string[] = [];
    using owner = new OrchestrationService({
      projectRoot,
      env: environment(),
      modelClient: new Client(outputs, false),
      playbookName: "define",
    });
    const priorRef = owner.artifacts.persist({
      metadata: priorMetadata,
      content: canonicalJson(prior.specification),
    });
    const { request, draft } = draftFor(priorRef.artifact_id);
    outputs.push(
      orientation,
      Buffer.from(
        persistedSpecificationDraftV3(
          { ...draft, source_coverage: draft.source_coverage.slice(0, -1) },
          request
        )
      ).toString("utf8"),
      Buffer.from(persistedSpecificationDraftV3(draft, request)).toString("utf8"),
      pass,
      approve
    );
    const runId = "completed-assurance-revision";
    const terminal = await owner.execute({
      schema_version: 2,
      action: "start",
      identity: {
        schema_version: 2,
        run_id: runId,
        session_id: runId,
        playbook: "define",
        engine_owner: "typescript",
      },
      goal: request.goal,
      constraints,
      project_root: projectRoot,
      trust_profile: "hardened-untrusted",
      input_artifacts: {
        schema_version: 2,
        artifacts: [{ slot: "prior-specification", ref: priorRef }],
      },
    });
    if (terminal.action !== "complete") throw new Error(`revision ended ${terminal.action}`);
    const revised = terminal.artifacts.find(
      (item) => item.kind === "specification" && item.run_id === runId
    );
    if (revised === undefined) throw new Error("revised product absent");
    const input = admission(owner, revised);
    const ready = prepareCompositionAssurance(input);
    expect(ready).toMatchObject({
      status: "prepared",
      assurance: {
        mode: "reviewed_definition",
        immediate_parent: { status: "verified", ref: priorRef },
      },
    });
    // Exact prior bytes are required; a pruned parent cannot be silently ignored.
    unlinkSync(
      path.join(
        owner.artifacts.root,
        "objects",
        "sha256",
        priorRef.content_digest.slice(0, 2),
        priorRef.content_digest.slice(2)
      )
    );
    expect(prepareCompositionAssurance(input)).toMatchObject({
      status: "refused",
      code: "SPECIFICATION_REVISION_CLOSURE_INVALID",
    });
  });
  it("keeps orphaned start artifacts but refuses a retry after a checked review object disappears", async () => {
    using owner = service();
    const ref = await completed(owner);
    const input = admission(owner, ref);
    const prepared = prepareCompositionAssurance(input);
    if (prepared.status !== "prepared") throw new Error("Define proof did not prepare");
    const materialized = materializeCompositionAssurance(input, prepared.assurance);
    if (materialized.status !== "materialized") throw new Error("prospective artifacts absent");
    const terminal = owner.checkpointer.loadRunById(ref.run_id)?.terminalDirective;
    if (terminal?.action !== "complete") throw new Error("Define terminal absent");
    const receipt = terminal.artifacts.find(
      (item) => item.kind === "review-receipt" && item.branch_id === "quality"
    );
    if (receipt === undefined) throw new Error("quality receipt absent");
    // Simulate a pruned proof object in the disposable store, not a guessed fallback.
    unlinkSync(
      path.join(
        owner.artifacts.root,
        "objects",
        "sha256",
        receipt.content_digest.slice(0, 2),
        receipt.content_digest.slice(2)
      )
    );
    expect(materializeCompositionAssurance(input, prepared.assurance)).toMatchObject({
      status: "refused",
      code: "SPECIFICATION_ASSURANCE_CUSTODY_INVALID",
    });
    expect(owner.checkpointer.runExists(input.consumer.run_id)).toBe(false);
    expect(owner.artifacts.read(materialized.assurance_ref).byteLength).toBeGreaterThan(0);
    expect(
      prepareCompositionAssurance(admission(owner, ref, "semantic_only", "new-semantic-consumer"))
    ).toMatchObject({
      status: "prepared",
      assurance: { mode: "semantic_only" },
    });
  });
  it("refuses unfinished owner state, wrong project, cancellation and substitution without weaker retry", async () => {
    using owner = service();
    const ref = await completed(owner);
    const base = admission(owner, ref);
    expect(
      prepareCompositionAssurance({ ...base, project_id: `prj_${"f".repeat(32)}` })
    ).toMatchObject({ status: "refused", code: "SPECIFICATION_ASSURANCE_CUSTODY_INVALID" });
    const signal = new AbortController();
    signal.abort();
    expect(prepareCompositionAssurance({ ...base, signal: signal.signal })).toMatchObject({
      status: "refused",
      code: "SPECIFICATION_ASSURANCE_CANCELLED",
    });
    expect(
      prepareCompositionAssurance({
        ...base,
        specification_ref: { ...ref, content_digest: "0".repeat(64) },
      })
    ).toMatchObject({ status: "refused", code: "SPECIFICATION_ASSURANCE_CUSTODY_INVALID" });
    expect(
      prepareCompositionAssurance({
        ...base,
        specification_ref: { ...ref, run_id: "no-such-producer" },
      })
    ).toMatchObject({ status: "refused", code: "SPECIFICATION_ASSURANCE_CUSTODY_INVALID" });
  });
});
