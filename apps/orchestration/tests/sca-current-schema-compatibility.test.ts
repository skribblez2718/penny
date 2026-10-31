import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import {
  Checkpointer,
  ORCHESTRATION_DATABASE_SCHEMA_VERSION,
  ORCHESTRATION_UPGRADE_SOURCE_VERSIONS,
} from "../dist/checkpointer.js";
import { ChildWorkflowCallRecordV2Schema } from "../dist/child-workflows/contracts.js";
import { createReservedChildWorkflowCallRecord } from "../dist/child-workflows/storage.js";
import {
  CurrentArtifactRefSchema,
  ExecutionReceiptSchema,
  InputArtifactsSchema,
  LeaseBoundInvokeChildWorkflowDirectiveV1Schema,
  RunIdentitySchema,
  type ArtifactRef,
  type InputArtifacts,
  type LeaseBoundInvokeChildWorkflowDirectiveV1,
  type RunIdentity,
} from "../dist/contracts.js";
import {
  initializePennyState,
  PennyStateResolutionError,
  resolvePennyRuntimeState,
} from "../dist/state/setup.js";
import { requireNumber, requireRecord, requireSqlite } from "./helpers/narrowing.js";

const roots: string[] = [];
const CREATED_AT = "2026-09-14T12:00:00.000Z";

function fixture(label: string) {
  const root = mkdtempSync(path.join(tmpdir(), `penny-sca-current-schema-${label}-`));
  chmodSync(root, 0o700);
  roots.push(root);
  const projectRoot = path.join(root, "project");
  mkdirSync(projectRoot, { mode: 0o700 });
  const env = { PENNY_STATE_ROOT: path.join(root, "state") };
  const state = initializePennyState(projectRoot, { env });
  return { projectRoot, env, state };
}

function database(file: string): import("node:sqlite").DatabaseSync {
  const sqlite = requireSqlite(
    process.getBuiltinModule("node:sqlite"),
    "SCA current-schema compatibility test SQLite runtime"
  );
  return new sqlite.DatabaseSync(file);
}

function userVersion(file: string): number {
  using db = database(file);
  const row = requireRecord(db.prepare("PRAGMA user_version").get(), "user-version row");
  return requireNumber(row["user_version"], "user-version value");
}

function runtimeResolutionError(
  projectRoot: string,
  env: NodeJS.ProcessEnv
): PennyStateResolutionError {
  try {
    resolvePennyRuntimeState(projectRoot, { env });
  } catch (error) {
    if (error instanceof PennyStateResolutionError) return error;
    throw error;
  }
  throw new Error("runtime unexpectedly admitted incompatible orchestration state");
}

function persistCurrentRef(artifacts: ArtifactStore, identity: RunIdentity): ArtifactRef {
  return artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: identity.run_id,
      phase: "admission",
      branch_id: null,
      kind: "child-request",
      operation_id: "sca-current-schema-request",
      version: 1,
      producer: "sca-current-schema-test",
      media_type: "application/json",
      content_schema: {
        schema_id: "penny.child-workflow-request.v1",
        schema_version: 1,
      },
      parent_ref: null,
      upstream_refs: [],
    },
    content: JSON.stringify({ schema_version: 1, purpose: "current-schema-reuse" }),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("S-00 current-schema reuse boundary", () => {
  it("admits current platform refs and a new v3 directive/V2 call on fresh v13 state", () => {
    const { projectRoot, env, state } = fixture("fresh");
    expect(ORCHESTRATION_DATABASE_SCHEMA_VERSION).toBe(13);
    expect(ORCHESTRATION_UPGRADE_SOURCE_VERSIONS).toEqual([10, 11, 12]);
    expect(
      Checkpointer.inspectExistingSchema(state.paths.orchestration.database, state.projectId)
    ).toEqual({
      actualVersion: 13,
      requiredVersion: 13,
      upgradeRequired: false,
      upgradeSupported: false,
    });

    const identity: RunIdentity = {
      schema_version: 2,
      run_id: "sca-current-parent",
      session_id: "sca-current-session",
      playbook: "research",
      engine_owner: "typescript",
    };
    expect(Value.Check(RunIdentitySchema, identity)).toBe(true);

    using artifacts = ArtifactStore.openExisting(state.paths.artifacts.root, {
      projectId: state.projectId,
    });
    const requestRef = persistCurrentRef(artifacts, identity);
    expect(Value.Check(CurrentArtifactRefSchema, requestRef)).toBe(true);
    const inputArtifacts: InputArtifacts = {
      schema_version: 2,
      artifacts: [{ slot: "admitted_source", ref: requestRef }],
    };
    expect(Value.Check(InputArtifactsSchema, inputArtifacts)).toBe(true);
    expect(
      Value.Check(ExecutionReceiptSchema, {
        schema_version: 2,
        receipt_id: "sca-current-receipt",
        run_id: identity.run_id,
        state_id: "admission",
        branch_id: null,
        agent: "echo",
        attempt: 1,
        worker_id: "sca-current-worker",
        executor: "pi-sdk",
        command: ["provider-free-fixture"],
        model: null,
        working_directory: projectRoot,
        trust_profile: "trusted-interactive",
        started_at: CREATED_AT,
        ended_at: CREATED_AT,
        exit_code: 0,
        output_digest: "a".repeat(64),
        output_artifact_ref: requestRef,
        trusted_invocation_digest: "b".repeat(64),
        signature: `hmac-sha256:${"c".repeat(64)}`,
      })
    ).toBe(true);

    const directive = {
      schema_version: 3,
      action: "invoke_child_workflow",
      identity,
      state_id: "admission",
      call_key: "sca-current-child",
      child_name: "research",
      request_ref: requestRef,
      input_artifacts: inputArtifacts,
      expected_output: {
        schema_version: 1,
        port_name: "grounded_synthesis",
        schema_id: "penny.grounded-synthesis.v1",
        schema_version_required: 1,
        artifact_kind: "semantic-core",
      },
      policy_binding: {
        schema_version: 1,
        project_id: state.projectId,
        principal_id: "sca-current-principal",
        scope_id: "sca-current-scope",
        source_policy_id: "sca-current-source-policy",
        destination_policy_id: "sca-current-destination-policy",
      },
      progress_lease: {
        schema_version: 1,
        profile_id: "sca-current-lease-profile",
        profile_version: 1,
        profile_sha256: "d".repeat(64),
        calibration_id: "sca-current-calibration",
        calibration_sha256: "e".repeat(64),
        provider_id: "provider-free",
        model_id: "provider-free",
        operation_class: "child_execution",
        inactivity_interval_ms: 1_000,
        renewal_policy: "trusted_host_activity_or_convergence_v1",
      },
    } as const satisfies LeaseBoundInvokeChildWorkflowDirectiveV1;
    expect(Value.Check(LeaseBoundInvokeChildWorkflowDirectiveV1Schema, directive)).toBe(true);

    const record = createReservedChildWorkflowCallRecord({
      directive,
      parent_visit_sequence: 1,
      parent_visit_offset: 0,
      parent_registration_sha256: "f".repeat(64),
      child_registration_sha256: "1".repeat(64),
      timestamp: CREATED_AT,
    });
    expect(record.schema_version).toBe(2);
    expect(Value.Check(ChildWorkflowCallRecordV2Schema, record)).toBe(true);

    expect(resolvePennyRuntimeState(projectRoot, { env }).projectId).toBe(state.projectId);
    expect(userVersion(state.paths.orchestration.database)).toBe(13);
  });

  it("refuses old and unsupported versions during ordinary resolution without mutating them", () => {
    const { projectRoot, env, state } = fixture("refusal");
    using db = database(state.paths.orchestration.database);
    db.exec("PRAGMA user_version=11;");
    expect(userVersion(state.paths.orchestration.database)).toBe(11);

    const old = runtimeResolutionError(projectRoot, env);
    expect(old).toMatchObject({
      code: "STATE_SCHEMA_INCOMPATIBLE",
      details: {
        actualSchemaVersion: 11,
        requiredSchemaVersion: 13,
        upgradeSupported: true,
        recoveryAction: "penny-state-upgrade",
      },
    });
    expect(userVersion(state.paths.orchestration.database)).toBe(11);

    db.exec("PRAGMA user_version=14;");
    expect(userVersion(state.paths.orchestration.database)).toBe(14);
    const newer = runtimeResolutionError(projectRoot, env);
    expect(newer).toMatchObject({
      code: "STATE_SCHEMA_INCOMPATIBLE",
      details: {
        actualSchemaVersion: 14,
        requiredSchemaVersion: 13,
        upgradeSupported: false,
      },
    });
    expect(newer.details.recoveryAction).toBeUndefined();
    expect(userVersion(state.paths.orchestration.database)).toBe(14);
  });
});
