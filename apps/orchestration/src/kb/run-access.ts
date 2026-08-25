import type { RunContext } from "../context.js";
import { readManifest, readPolicy } from "./filesystem.js";
import { checkParentModelIdentity, PolicyRefusal } from "./policy.js";
import { recheckAdmittedPolicy } from "./workflows.js";

/** Bounded refusal for a run outside the active host session/profile authority. */
export class KbRunAccessError extends Error {
  readonly code = "run_not_available_for_session_profile";
  constructor() {
    super("KB run is not available to the active host session and profile");
    this.name = "KbRunAccessError";
  }
}

/**
 * Bind status/resume to one exact KB run, authenticated Pi session, and profile.
 * The check returns no location or body and deliberately uses one public refusal
 * code so callers cannot probe another session's run inventory.
 */
export function requireKbRunAccess(
  run: RunContext | undefined,
  expected: { runId: string; sessionId: string; profileId: string }
): RunContext {
  if (
    run === undefined ||
    run.identity.run_id !== expected.runId ||
    run.identity.playbook !== "knowledge-base" ||
    run.identity.session_id !== expected.sessionId ||
    String(run.knowledgeBaseData.profile_id ?? "") !== expected.profileId
  ) {
    throw new KbRunAccessError();
  }
  return run;
}

/** Recheck that registry remapping cannot redirect a run to another KB identity. */
export function requireKbRunIdentityCurrent(run: RunContext, kbRoot: string): void {
  const admittedKbId = String(run.knowledgeBaseData.kb_id ?? "");
  if (admittedKbId.length === 0 || readManifest(kbRoot).kb_id !== admittedKbId) {
    throw new KbRunAccessError();
  }
}

/** Current parent admission required before status/resume can read any private artifact. */
export function requireKbCurrentParent(
  kbRoot: string,
  parentIdentity: { provider: string; model: string } | undefined
): void {
  if (parentIdentity === undefined) {
    throw new PolicyRefusal("parent_model_denied", "the active parent identity is unavailable");
  }
  checkParentModelIdentity(readPolicy(kbRoot), parentIdentity);
}

/** Recheck the admitted policy for every nonterminal status/resume continuation. */
export function requireKbRunPolicyCurrent(run: RunContext, kbRoot: string): void {
  if (["complete", "incomplete", "error", "cancelled"].includes(run.status)) return;
  const admittedPolicySha256 = String(run.knowledgeBaseData.admitted_policy_sha256 ?? "");
  if (admittedPolicySha256.length === 0) {
    throw new PolicyRefusal("policy_changed", "the run has no admitted policy binding");
  }
  recheckAdmittedPolicy({ kbRoot, admittedPolicySha256 });
}
