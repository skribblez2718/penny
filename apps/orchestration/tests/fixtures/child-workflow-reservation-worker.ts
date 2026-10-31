import { existsSync, writeFileSync } from "node:fs";

import { ArtifactStore } from "../../dist/artifact-store.js";
import { Checkpointer } from "../../dist/checkpointer.js";
import { ChildWorkflowStateOwner } from "../../dist/child-workflows/owner.js";
import { validateChildWorkflowCallRecord } from "../../dist/child-workflows/contracts.js";
import { RunContext } from "../../dist/context.js";

function argument(index: number): string {
  const value = process.argv[index + 2];
  if (value === undefined) throw new Error(`missing worker argument ${index}`);
  return value;
}

async function waitForRelease(releasePath: string): Promise<void> {
  while (!existsSync(releasePath)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

const databasePath = argument(0);
const artifactRoot = argument(1);
const projectId = argument(2);
const record = validateChildWorkflowCallRecord(JSON.parse(argument(3)));
if (record.schema_version !== 1) throw new Error("reservation worker requires a legacy V1 fixture");
const projectRoot = argument(4);
const readyPath = argument(5);
const releasePath = argument(6);

try {
  using checkpointer = Checkpointer.openExisting(databasePath, undefined, { projectId });
  using artifacts = ArtifactStore.openExisting(artifactRoot, { projectId });
  const owner = new ChildWorkflowStateOwner(checkpointer, artifacts);
  const childContext = RunContext.create({
    identity: record.child_identity,
    goal: "concurrent child-workflow storage fixture",
    constraints: {},
    projectRoot,
    trustProfile: "trusted-interactive",
    maxSteps: record.budget.max_steps,
    registrationContractBinding: {
      schema_version: 1,
      registration_name: record.child_identity.playbook,
      contract_sha256: "c".repeat(64),
      registration_sha256: record.child_registration_sha256,
    },
  });

  writeFileSync(readyPath, "ready", { flag: "wx", mode: 0o600 });
  await waitForRelease(releasePath);
  const outcome = owner.reserve({ record, childContext });
  process.stdout.write(`${JSON.stringify({ kind: outcome.kind })}\n`);
} catch (error) {
  writeFileSync(
    `${readyPath}.error`,
    error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`,
    { mode: 0o600 }
  );
  throw error;
}
