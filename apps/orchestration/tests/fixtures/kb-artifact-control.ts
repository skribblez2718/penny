import { Checkpointer, canonicalJson, sha256 } from "../../src/checkpointer.js";
import { RunContext } from "../../src/context.js";
import { materializeRunInput } from "../../src/private-inputs.js";
import type { StartKbAction } from "../../src/kb/contracts.js";
import { installTestProjectState } from "./penny-state-fixture.js";

const controls = new Map<string, Checkpointer>();

/** Explicit test-only orchestration control DB for deterministic KB fixtures. */
export function kbArtifactControl(input: {
  root: string;
  runId: string;
  profileId: string;
  action?: StartKbAction;
  sessionId?: string;
}): Checkpointer {
  installTestProjectState(input.root);
  let checkpointer = controls.get(input.root);
  if (checkpointer === undefined) {
    checkpointer = new Checkpointer(":memory:");
    controls.set(input.root, checkpointer);
  }
  if (!checkpointer.runExists(input.runId)) {
    const action = input.action ?? "ingest";
    const sessionId = input.sessionId ?? `test_session_${input.runId}`;
    const context = RunContext.create({
      identity: {
        schema_version: 2,
        run_id: input.runId,
        session_id: sessionId,
        playbook: "knowledge-base",
        engine_owner: "typescript",
      },
      goal: "Explicit deterministic KB fixture control run.",
      constraints: {
        action,
        kb_profile_id: input.profileId,
      },
      projectRoot: input.root,
      trustProfile: "hardened-untrusted",
      maxSteps: 16,
    });
    context.playbookData.action = action;
    context.playbookData.profile_id = input.profileId;
    context.playbookData.admitted_policy_sha256 = "a".repeat(64);
    const request = { schema_version: 1, action, kb_profile_id: input.profileId };
    const requestSha256 = sha256(canonicalJson(request));
    const transactionId = `tx_fixture_${input.runId}`;
    checkpointer.admitStartRun(context, {
      session_id: sessionId,
      invocation_id: `call_fixture_${input.runId}`,
      request_sha256: requestSha256,
      action,
      profile_id: input.profileId,
      transaction_id: transactionId,
      private_input_id: `pri_fixture_${input.runId}`,
      storage_key: `${input.runId}/request.json`,
      temporary_storage_key: `${input.runId}/.${transactionId}.tmp`,
    });
    materializeRunInput({
      projectRoot: input.root,
      checkpointer,
      runId: input.runId,
      request,
      requestSha256,
    });
  }
  return checkpointer;
}

export function closeKbArtifactControls(): void {
  for (const checkpointer of controls.values()) checkpointer.close();
  controls.clear();
}
