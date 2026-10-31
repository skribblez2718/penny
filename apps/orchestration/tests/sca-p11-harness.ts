import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ArtifactStore } from "../dist/artifact-store.js";
import type { ArtifactRef, Directive, JsonValue, StartRequest } from "../dist/contracts.js";
import { RunContext } from "../dist/context.js";
import {
  SCA_P11_CANDIDATE_PLAYBOOK_NAME,
  ScaP11CandidatePlaybook,
  buildScaP11CandidateRegistrationWithBindingV1,
  type ScaP11CandidateBindingV1,
} from "../dist/sca/p11-playbook.js";
import {
  SCA_P11_REPAIRING_STATE,
  SCA_P11_REVIEWING_STATE,
  validateScaP11CognitivePayloadV1,
  validateScaP11ReportJsonV1,
  type ScaP11CognitivePayloadV1,
} from "../dist/sca/p11-contracts.js";
import {
  buildScaP11Lineage,
  slotsForP11,
  P11_PROJECT_ROOT,
  type ScaP11LineageV1,
} from "./sca-p11-lineage.js";

export { P11_PROJECT_ROOT };

export function createP11ArtifactStore(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p11-harness-"));
  return new ArtifactStore(path.join(root, "artifacts"));
}

export function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is absent`);
  return value;
}

export function readJson(artifacts: ArtifactStore, ref: ArtifactRef): unknown {
  return JSON.parse(artifacts.readById(ref.artifact_id).toString("utf8"));
}

export function selectedRef(run: RunContext, kind: string): ArtifactRef {
  return required(
    [...run.selectedArtifacts].reverse().find((ref) => ref.kind === kind),
    `selected ${kind}`
  );
}

export interface P11Harness {
  readonly artifacts: ArtifactStore;
  readonly run: RunContext;
  readonly playbook: ScaP11CandidatePlaybook;
  readonly registration: ReturnType<typeof buildScaP11CandidateRegistrationWithBindingV1>;
  readonly lineage: ReturnType<typeof buildScaP11Lineage>;
}

export function prepareP11(input: {
  readonly store: ArtifactStore;
  readonly runId: string;
  readonly reportPolicyComplete?: boolean;
  readonly binding?: ScaP11CandidateBindingV1;
  readonly p10Status?: "learning_complete" | "learning_incomplete";
  readonly reassessmentRef?: ArtifactRef | null;
  readonly priorReportRef?: ArtifactRef | null;
  readonly lineage?: ScaP11LineageV1;
  readonly mutateConstraints?: (
    constraints: ScaP11LineageV1["constraints"]
  ) => ScaP11LineageV1["constraints"];
}): P11Harness {
  const binding = input.binding ?? {};
  const registration = buildScaP11CandidateRegistrationWithBindingV1(binding);
  const lineage =
    input.lineage ??
    buildScaP11Lineage({
      store: input.store,
      run_id: input.runId,
      confirmed: true,
      accepted: true,
      report_policy_complete: input.reportPolicyComplete ?? true,
      ...(input.p10Status === undefined ? {} : { p10_status: input.p10Status }),
    });
  const baseConstraints = {
    ...lineage.constraints,
    ...(input.reassessmentRef === undefined ? {} : { p11_reassessment_ref: input.reassessmentRef }),
    ...(input.priorReportRef === undefined ? {} : { p11_prior_report_ref: input.priorReportRef }),
  };
  const constraints = input.mutateConstraints
    ? input.mutateConstraints(baseConstraints)
    : baseConstraints;
  const startAdmission = required(registration.start_admission, "P11 start admission");
  const request: StartRequest = {
    schema_version: 2,
    action: "start",
    identity: {
      schema_version: 2,
      run_id: input.runId,
      session_id: `session-${input.runId}`,
      playbook: SCA_P11_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript",
    },
    goal: "Exercise the inactive P11 reporting candidate.",
    constraints,
    project_root: P11_PROJECT_ROOT,
    trust_profile: "hardened-untrusted",
    input_artifacts: { schema_version: 2, artifacts: slotsForP11(constraints) },
  };
  const prepared = startAdmission.prepare(request, {});
  const refs = startAdmission.materialize(prepared, {
    run_id: input.runId,
    artifactStore: input.store,
    trustedClock: () => new Date("2026-10-02T00:00:06.000Z"),
  });
  const run = RunContext.create({
    identity: request.identity,
    goal: request.goal,
    constraints: {},
    projectRoot: P11_PROJECT_ROOT,
    trustProfile: "hardened-untrusted",
    maxSteps: 64,
    initialArtifacts: refs,
    registrationContractBinding: {
      schema_version: 1,
      registration_name: SCA_P11_CANDIDATE_PLAYBOOK_NAME,
      contract_sha256: "b".repeat(64),
      registration_sha256: "a".repeat(64),
    },
  });
  const playbook = new ScaP11CandidatePlaybook(
    input.store,
    binding,
    () => new Date("2026-10-02T00:00:06.000Z")
  );
  return { artifacts: input.store, run, playbook, registration, lineage };
}

export interface P11PayloadContext {
  readonly payload: ScaP11CognitivePayloadV1;
  readonly revision: number;
  readonly reportRef: ArtifactRef;
}

export type P11TerminalDirective = Extract<Directive, { result: Record<string, JsonValue> }>;

export function asTerminal(directive: Directive): P11TerminalDirective {
  if (directive.action !== "incomplete" && directive.action !== "cancelled") {
    throw new Error(`expected a P11 terminal directive, received '${directive.action}'`);
  }
  return directive;
}

/**
 * Drive the playbook through every review/repair opening with caller-supplied stub outputs until it
 * reaches a terminal directive. The review stub must return a closed semantic-review object and the
 * repair stub (when the loop opens one) a closed repair patch.
 */
export function driveP11(input: {
  readonly harness: P11Harness;
  readonly review: (context: P11PayloadContext) => Record<string, JsonValue>;
  readonly repair?: (context: P11PayloadContext) => Record<string, JsonValue>;
  readonly initial?: Directive;
}): P11TerminalDirective {
  const { artifacts, run, playbook } = input.harness;
  let directive = input.initial ?? playbook.initialize(run);
  for (let step = 0; step < 32 && directive.action === "invoke_agent"; step += 1) {
    if (
      directive.state_id !== SCA_P11_REVIEWING_STATE &&
      directive.state_id !== SCA_P11_REPAIRING_STATE
    ) {
      throw new Error(`unexpected P11 cognitive state '${directive.state_id}'`);
    }
    const reportRef = selectedRef(run, "sca-p11-report-json");
    const report = validateScaP11ReportJsonV1(readJson(artifacts, reportRef));
    const revision = report.revision;
    const payloadRef = required(
      directive.input_artifacts.artifacts.find((binding) => binding.slot === "cognitive_payload")
        ?.ref,
      "cognitive payload ref"
    );
    const payload = validateScaP11CognitivePayloadV1(readJson(artifacts, payloadRef));
    const context: P11PayloadContext = { payload, revision, reportRef };
    const details =
      directive.state_id === SCA_P11_REVIEWING_STATE
        ? input.review(context)
        : (
            input.repair ??
            (() => {
              throw new Error("P11 harness opened a repair without a repair stub");
            })
          )(context);
    run.pendingDirective = null;
    directive = playbook.acceptSummary(run, details, "CERTAIN");
  }
  return asTerminal(directive);
}
