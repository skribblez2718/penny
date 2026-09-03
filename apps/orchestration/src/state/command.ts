import path from "node:path";

import { deleteStateMigrationLegacy, prepareStateMigrationDeletion } from "./deletion.js";
import { createStateMigrationPlan } from "./migration-plan.js";
import { applyStateMigration, finalizeStateMigration, verifyStateMigration } from "./migration.js";
import { initializePennyState, relinkPennyProject, resolvePennyStateStatus } from "./setup.js";

export type StateCommandResult =
  | {
      readonly schema_version: 1;
      readonly action: "init" | "status" | "relink";
      readonly project_id: string;
      readonly state_root: string;
      readonly project_state_root: string;
      readonly orchestration_database: string;
      readonly orchestration_receipt_key: string;
      readonly artifact_manifest_database: string;
    }
  | {
      readonly schema_version: 1;
      readonly action:
        | "migrate-plan"
        | "migrate-apply"
        | "migrate-verify"
        | "migrate-finalize"
        | "migrate-authorize-delete"
        | "migrate-delete";
      readonly migration_id: string;
      readonly project_id?: string;
      readonly plan_sha256: string;
      readonly phase?: "applying" | "applied" | "verified" | "finalized";
      readonly completed_stores?: readonly string[];
      readonly output?: string;
      readonly deleted_entries?: readonly string[];
      readonly semantic_verification?: {
        readonly historical_receipts_verified: number;
        readonly artifact_object_bindings_verified: number;
        readonly skill_chain_artifact_refs_verified: number;
        readonly kb_authorities: readonly unknown[];
      };
    }
  | { readonly schema_version: 1; readonly action: "help"; readonly text: string };

const HELP = [
  "Usage:",
  "  penny-state init --project-root=PATH",
  "  penny-state status --project-root=PATH",
  "  penny-state relink --project-id=ID --current-project-root=PATH --replacement-project-root=PATH",
  "  penny-state migrate plan --project-root=PATH --source-manifest=PATH --output=PATH",
  "  penny-state migrate apply --project-root=PATH --source-manifest=PATH --plan=PATH",
  "  penny-state migrate verify --project-root=PATH --plan=PATH",
  "  penny-state migrate finalize --project-root=PATH --plan=PATH",
  "  penny-state migrate authorize-delete --project-root=PATH --source-manifest=PATH --plan=PATH --deletion-manifest=PATH --approval=PATH --confirmation=MIGRATION_ID:DELETE-ALL-MANAGED-LEGACY",
  "  penny-state migrate delete --project-root=PATH --source-manifest=PATH --plan=PATH --deletion-manifest=PATH --approval=PATH",
  "",
  "State location:",
  "  ${PENNY_STATE_ROOT:-<Pi getAgentDir()>/penny}",
  "",
  "Init/status never inspect or import legacy roots; only explicit migrate phases read named sources.",
].join("\n");

function option(arguments_: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const value = arguments_.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  return value?.trim() || undefined;
}

function requiredAbsoluteOption(arguments_: readonly string[], name: string): string {
  const value = option(arguments_, name);
  if (value === undefined) throw new Error(`--${name}=PATH is required`);
  if (!path.isAbsolute(value)) throw new Error(`--${name} must be an absolute path`);
  return path.normalize(value);
}

function result(
  action: "init" | "status" | "relink",
  binding: ReturnType<typeof initializePennyState>
): StateCommandResult {
  return {
    schema_version: 1,
    action,
    project_id: binding.projectId,
    state_root: binding.state.root,
    project_state_root: binding.paths.root,
    orchestration_database: binding.paths.orchestration.database,
    orchestration_receipt_key: binding.paths.orchestration.receiptKey,
    artifact_manifest_database: binding.paths.artifacts.manifestDatabase,
  };
}

export async function executeStateCommand(
  arguments_: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<StateCommandResult> {
  const [command] = arguments_;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { schema_version: 1, action: "help", text: HELP };
  }
  if (command === "init") {
    const projectRoot = requiredAbsoluteOption(arguments_, "project-root");
    return result("init", initializePennyState(projectRoot, { env }));
  }
  if (command === "status") {
    const projectRoot = requiredAbsoluteOption(arguments_, "project-root");
    return result("status", resolvePennyStateStatus(projectRoot, { env }));
  }
  if (command === "migrate") {
    const phase = arguments_[1];
    const projectRoot = requiredAbsoluteOption(arguments_, "project-root");
    if (phase === "plan") {
      const sourceManifestPath = requiredAbsoluteOption(arguments_, "source-manifest");
      const output = requiredAbsoluteOption(arguments_, "output");
      const plan = createStateMigrationPlan({
        projectRoot,
        sourceManifestPath,
        outputPath: output,
        rootOptions: { env },
      });
      return {
        schema_version: 1,
        action: "migrate-plan",
        migration_id: plan.migration_id,
        project_id: plan.target_project_id,
        plan_sha256: plan.plan_sha256,
        output,
      };
    }
    const planPath = requiredAbsoluteOption(arguments_, "plan");
    if (phase === "apply") {
      const sourceManifestPath = requiredAbsoluteOption(arguments_, "source-manifest");
      const migrated = await applyStateMigration({
        projectRoot,
        sourceManifestPath,
        planPath,
        rootOptions: { env },
      });
      return {
        schema_version: 1,
        action: "migrate-apply",
        migration_id: migrated.migration_id,
        project_id: migrated.project_id,
        plan_sha256: migrated.plan_sha256,
        phase: migrated.phase,
        completed_stores: migrated.completed_stores,
      };
    }
    if (phase === "verify") {
      const verified = await verifyStateMigration({ projectRoot, planPath, rootOptions: { env } });
      return {
        schema_version: 1,
        action: "migrate-verify",
        migration_id: verified.migration_id,
        project_id: verified.project_id,
        plan_sha256: verified.plan_sha256,
        phase: verified.phase,
        completed_stores: verified.completed_stores,
        semantic_verification: verified.semantic_verification,
      };
    }
    if (phase === "finalize") {
      const finalized = await finalizeStateMigration({
        projectRoot,
        planPath,
        rootOptions: { env },
      });
      return {
        schema_version: 1,
        action: "migrate-finalize",
        migration_id: finalized.migration_id,
        project_id: finalized.project_id,
        plan_sha256: finalized.plan_sha256,
        phase: finalized.phase,
        completed_stores: finalized.completed_stores,
      };
    }
    if (phase === "authorize-delete") {
      const sourceManifestPath = requiredAbsoluteOption(arguments_, "source-manifest");
      const deletionManifestPath = requiredAbsoluteOption(arguments_, "deletion-manifest");
      const approvalPath = requiredAbsoluteOption(arguments_, "approval");
      const confirmation = option(arguments_, "confirmation");
      if (confirmation === undefined) throw new Error("--confirmation=VALUE is required");
      const approval = await prepareStateMigrationDeletion({
        projectRoot,
        sourceManifestPath,
        planPath,
        deletionManifestPath,
        approvalPath,
        confirmation,
        rootOptions: { env },
      });
      return {
        schema_version: 1,
        action: "migrate-authorize-delete",
        migration_id: approval.migration_id,
        project_id: approval.project_id,
        plan_sha256: approval.plan_sha256,
        output: approvalPath,
      };
    }
    if (phase === "delete") {
      const sourceManifestPath = requiredAbsoluteOption(arguments_, "source-manifest");
      const deletionManifestPath = requiredAbsoluteOption(arguments_, "deletion-manifest");
      const approvalPath = requiredAbsoluteOption(arguments_, "approval");
      const approval = await deleteStateMigrationLegacy({
        projectRoot,
        sourceManifestPath,
        planPath,
        deletionManifestPath,
        approvalPath,
        rootOptions: { env },
      });
      return {
        schema_version: 1,
        action: "migrate-delete",
        migration_id: approval.migration_id,
        project_id: approval.project_id,
        plan_sha256: approval.plan_sha256,
        deleted_entries: approval.completed_entry_ids,
      };
    }
    throw new Error(
      "unknown migrate phase; expected plan, apply, verify, finalize, authorize-delete, or delete"
    );
  }
  if (command === "relink") {
    const projectId = option(arguments_, "project-id");
    if (projectId === undefined) throw new Error("--project-id=ID is required");
    const currentRoot = requiredAbsoluteOption(arguments_, "current-project-root");
    const replacementRoot = requiredAbsoluteOption(arguments_, "replacement-project-root");
    return result("relink", relinkPennyProject(projectId, currentRoot, replacementRoot, { env }));
  }
  throw new Error(`unknown penny-state command: ${command}`);
}
