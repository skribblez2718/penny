import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Directive } from "../dist/contracts.js";
import { SqliteImagegenActivationController } from "../dist/imagegen/activation.js";
import { COMFY_IMAGEGEN_OPERATION_KIND } from "../dist/imagegen/operation-owner.js";
import { loadImagegenRuntimeFromEnvironment } from "../dist/imagegen/runtime-config.js";
import type { ImagegenStartAdmissionProvidersV1 } from "../dist/imagegen/types.js";
import type { HostOperationAdapterV1 } from "../dist/host-operations/contracts.js";
import {
  HostOperationSimulatedCrashError,
  type HostOperationFaultPointV1,
} from "../dist/host-operations/owner.js";
import { OrchestrationService } from "../dist/service.js";
import { initializePennyState } from "../dist/state/setup.js";
import { DeterministicImagegenSmokeModel } from "../tests/helpers/imagegen-smoke-model.js";
import {
  assertImagegenRecoveryLiveGate,
  imagegenRecoveryIssueCodes,
  IMAGEGEN_RECOVERY_BOUNDARY_FAULT_POINT,
  IMAGEGEN_RECOVERY_LIVE_CONSTRAINTS,
  IMAGEGEN_RECOVERY_LIVE_MANIFEST_ENV,
  type ImagegenRecoveryBoundaryObservationV1,
  type ImagegenRecoveryBoundaryV1,
} from "./imagegen-recovery-live-contract.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const REPORT_DIRECTORY = path.join(PROJECT_ROOT, ".penny", "imagegen", "qualification");
const REPORT_PATH = path.join(REPORT_DIRECTORY, "recovery-live.json");

type Fault = (point: HostOperationFaultPointV1, operation_kind: string) => void;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-imagegen-recovery-live-"));
  roots.push(root);
  return root;
}

interface Scenario {
  readonly env: NodeJS.ProcessEnv;
  readonly providers: ImagegenStartAdmissionProvidersV1;
  readonly adapters: ReadonlyMap<string, HostOperationAdapterV1>;
  readonly close: () => void;
}

function scenario(): Scenario {
  const root = temporaryRoot();
  const stateRoot = path.join(root, "state");
  mkdirSync(stateRoot, { mode: 0o700 });
  const manifestFile = process.env[IMAGEGEN_RECOVERY_LIVE_MANIFEST_ENV];
  if (manifestFile === undefined) {
    throw new Error(
      `Set ${IMAGEGEN_RECOVERY_LIVE_MANIFEST_ENV} to the operator-private imagegen runtime manifest.`
    );
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PENNY_STATE_ROOT: stateRoot,
    PENNY_IMAGEGEN_RUNTIME_MANIFEST_FILE: manifestFile,
    PI_OBSERVABILITY_AUTO_START: "false",
    PI_OBSERVABILITY_ENABLED: "false",
  };
  initializePennyState(PROJECT_ROOT, { env });
  const loaded = loadImagegenRuntimeFromEnvironment({ env, state_root: stateRoot });
  if (loaded === undefined) {
    throw new Error(
      `Set ${IMAGEGEN_RECOVERY_LIVE_MANIFEST_ENV} to the operator-private imagegen runtime manifest.`
    );
  }
  // Disposable, isolated start authority: the experiment never edits or enables the operator
  // manifest, and this controller lives in its own directory so the operator's durable mode is
  // untouched.
  const activation = new SqliteImagegenActivationController({
    directory: path.join(stateRoot, "recovery-activation"),
    mode: "enabled",
  });
  const providers: ImagegenStartAdmissionProvidersV1 = { ...loaded.providers, activation };
  return {
    env,
    providers,
    adapters: loaded.adapters,
    close: () => {
      activation.close();
      loaded.close();
    },
  };
}

function buildService(input: Scenario, fault?: Fault): OrchestrationService {
  return new OrchestrationService({
    projectRoot: PROJECT_ROOT,
    env: input.env,
    playbookName: "imagegen",
    imagegen: input.providers,
    hostOperationAdapters: input.adapters,
    modelClient: new DeterministicImagegenSmokeModel(),
    ...(fault === undefined ? {} : { hostOperationFault: fault }),
  });
}

function startRequest(runId: string): unknown {
  return {
    schema_version: 2,
    action: "start",
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: `session-${runId}`,
      playbook: "imagegen",
      engine_owner: "typescript",
    },
    goal: "Create one calm wordless blue geometric image for the recovery experiment.",
    constraints: IMAGEGEN_RECOVERY_LIVE_CONSTRAINTS,
    project_root: PROJECT_ROOT,
    trust_profile: "trusted-interactive",
  };
}

function recoverRequest(runId: string): unknown {
  return {
    schema_version: 2,
    action: "recover",
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: `session-${runId}`,
      playbook: "imagegen",
      engine_owner: "typescript",
    },
  };
}

function generationRecord(service: OrchestrationService, runId: string) {
  const calls = service.checkpointer
    .hostOperationCallsForRun(runId)
    .filter((call) => call.operation_kind === COMFY_IMAGEGEN_OPERATION_KIND);
  if (calls.length !== 1 || calls[0] === undefined) {
    throw new Error(
      `recovery experiment observed ${calls.length} generation operation records for '${runId}'`
    );
  }
  return calls[0];
}

/** Interruption seam that fires only for the exact generation operation kind. */
function crashAt(boundary: ImagegenRecoveryBoundaryV1): Fault {
  const point = IMAGEGEN_RECOVERY_BOUNDARY_FAULT_POINT[boundary];
  return (candidate, operationKind) => {
    if (candidate === point && operationKind === COMFY_IMAGEGEN_OPERATION_KIND) {
      throw new HostOperationSimulatedCrashError(candidate);
    }
  };
}

async function interrupt(
  service: OrchestrationService,
  runId: string,
  boundary: ImagegenRecoveryBoundaryV1,
  run: () => Promise<Directive>
): Promise<ImagegenRecoveryBoundaryObservationV1> {
  let crashed = false;
  try {
    await run();
  } catch (error) {
    if (error instanceof HostOperationSimulatedCrashError) crashed = true;
    else throw error;
  }
  expect(crashed, `boundary '${boundary}' did not interrupt`).toBe(true);
  const record = generationRecord(service, runId);
  return {
    boundary,
    durable_lifecycle_at_interrupt: record.lifecycle,
    remote_correlation_recorded_at_interrupt: record.remote_correlation_id !== null,
    resubmitted_after_recovery: false,
    terminal_outcome_after_recovery: "",
    lease_disposition_after_recovery: "",
  };
}

function finalizeObservation(
  observation: ImagegenRecoveryBoundaryObservationV1,
  final: {
    readonly remoteCorrelationRecorded: boolean;
    readonly outcome: string;
    readonly leaseDisposition: string;
  }
): ImagegenRecoveryBoundaryObservationV1 {
  return {
    ...observation,
    resubmitted_after_recovery:
      !observation.remote_correlation_recorded_at_interrupt &&
      final.remoteCorrelationRecorded &&
      final.outcome === "completed",
    terminal_outcome_after_recovery: final.outcome,
    lease_disposition_after_recovery: final.leaseDisposition,
  };
}

function writePrivateReport(observations: readonly ImagegenRecoveryBoundaryObservationV1[]): void {
  mkdirSync(REPORT_DIRECTORY, { recursive: true, mode: 0o700 });
  const report = JSON.stringify(
    { schema_version: 1, generated_at: new Date().toISOString(), observations },
    null,
    2
  );
  writeFileSync(REPORT_PATH, report, { mode: 0o600 });
  chmodSync(REPORT_PATH, 0o600);
}

describe("opt-in live imagegen interruption/recovery experiment", () => {
  it(
    "exercises all six durable recovery boundaries in disposable state",
    async () => {
      assertImagegenRecoveryLiveGate(process.env);
      const observations: ImagegenRecoveryBoundaryObservationV1[] = [];

      // (1) Before submit: proven non-acceptance, so recovery may resubmit.
      {
        const active = scenario();
        const runId = "run-recovery-before-submit";
        const first = buildService(active, crashAt("before_submit"));
        const interrupted = await interrupt(first, runId, "before_submit", () =>
          first.execute(startRequest(runId))
        );
        first.close();
        const second = buildService(active);
        const terminal = await second.execute(recoverRequest(runId));
        const record = generationRecord(second, runId);
        observations.push(
          finalizeObservation(interrupted, {
            remoteCorrelationRecorded: record.remote_correlation_id !== null,
            outcome: record.disposition?.outcome ?? "missing",
            leaseDisposition: record.disposition?.lease_disposition ?? "missing",
          })
        );
        expect(terminal.action).toBe("complete");
        second.close();
        active.close();
      }

      // (2) After the submit response but before the prompt-ID checkpoint: ambiguous acceptance
      // must quarantine the backend and never resubmit.
      {
        const active = scenario();
        const runId = "run-recovery-ambiguous";
        const first = buildService(active, crashAt("after_submit_before_prompt_id_checkpoint"));
        const interrupted = await interrupt(
          first,
          runId,
          "after_submit_before_prompt_id_checkpoint",
          () => first.execute(startRequest(runId))
        );
        first.close();
        const second = buildService(active);
        await second.execute(recoverRequest(runId));
        const record = generationRecord(second, runId);
        observations.push(
          finalizeObservation(interrupted, {
            remoteCorrelationRecorded: record.remote_correlation_id !== null,
            outcome: record.disposition?.outcome ?? "missing",
            leaseDisposition: record.disposition?.lease_disposition ?? "missing",
          })
        );
        second.close();
        active.close();
      }

      // (3)-(6) After the prompt-ID checkpoint, after fetch, after artifact persist, and before
      // routing: each disposable run proves exact adoption from that boundary without resubmission.
      // Separate runs keep every observation attributable to one interruption rather than relying
      // on a chain of synthetic crashes through one already-interrupted process lifetime.
      for (const boundary of [
        "after_prompt_id_checkpoint",
        "after_fetch",
        "after_artifact_persist",
        "before_routing",
      ] as const satisfies readonly ImagegenRecoveryBoundaryV1[]) {
        const active = scenario();
        const runId = `run-recovery-${boundary.replaceAll("_", "-")}`;
        const first = buildService(active, crashAt(boundary));
        const interrupted = await interrupt(first, runId, boundary, () =>
          first.execute(startRequest(runId))
        );
        first.close();
        const second = buildService(active);
        await second.execute(recoverRequest(runId));
        const record = generationRecord(second, runId);
        observations.push(
          finalizeObservation(interrupted, {
            remoteCorrelationRecorded: record.remote_correlation_id !== null,
            outcome: record.disposition?.outcome ?? "missing",
            leaseDisposition: record.disposition?.lease_disposition ?? "missing",
          })
        );
        second.close();
        active.close();
      }

      expect(observations.map((observation) => observation.boundary)).toEqual([
        "before_submit",
        "after_submit_before_prompt_id_checkpoint",
        "after_prompt_id_checkpoint",
        "after_fetch",
        "after_artifact_persist",
        "before_routing",
      ]);
      writePrivateReport(observations);
      expect(imagegenRecoveryIssueCodes(observations)).toEqual([]);
    },
    30 * 60_000
  );
});
