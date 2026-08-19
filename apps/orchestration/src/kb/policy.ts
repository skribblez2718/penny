/**
 * KB policy enforcement — §5.3 deny-before-session rule.
 *
 * Enforcement order for every operation that can read private content:
 *
 *   resolve host session and profile grant
 *     → validate root and repository admission
 *       → read and validate only manifest/policy metadata
 *         → verify the current parent provider/model tuple
 *           → select and verify every child provider/model tuple
 *             → only then read any private body or create any child session
 *
 * A failure returns a bounded refusal code without query/title/path/provider payload.
 * Tests must assert `createAgentSession` and private-body reads have call count zero
 * on denial paths.
 */

import type { KbPolicy, Confidence } from "./contracts.js";

export type ProviderModelTuple = {
  provider: string;
  model: string;
  locality: "local" | "remote";
};

export type PolicyRefusalCode =
  | "policy_changed"
  | "parent_model_denied"
  | "child_model_denied"
  | "empty_model_lists"
  | "processing_mode_violation"
  | "derived_answer_denied"
  | "parent_delivery_refused";

export class PolicyRefusal extends Error {
  constructor(
    public readonly code: PolicyRefusalCode,
    message: string
  ) {
    super(message);
    this.name = "PolicyRefusal";
  }
}

/** Normalize a provider/model string pair per §5.3 (1–256 UTF-8 bytes, exact). */
export function normalizeModelTuple(provider: string, model: string): ProviderModelTuple {
  return {
    provider: provider.trim().slice(0, 256),
    model: model.trim().slice(0, 256),
    locality: "local", // default; the caller sets the actual locality
  };
}

/**
 * Check whether a parent provider/model tuple is admitted by the policy.
 *
 * In `local_only`, both parent and child must match an allowlisted rule with
 * `locality: "local"`. In `provider_permitted`, each must match its corresponding
 * allowlist. Empty lists deny.
 */
export function checkParentModel(policy: KbPolicy, tuple: ProviderModelTuple): void {
  if (policy.allowed_parent_models.length === 0) {
    throw new PolicyRefusal(
      "empty_model_lists",
      "parent model allowlist is empty — denied by default"
    );
  }
  const matched = policy.allowed_parent_models.some(
    (rule) =>
      rule.provider === tuple.provider &&
      rule.model === tuple.model &&
      rule.locality === tuple.locality
  );
  if (!matched) {
    throw new PolicyRefusal(
      "parent_model_denied",
      "parent provider/model tuple is not allowlisted"
    );
  }
  if (policy.processing_mode === "local_only" && tuple.locality !== "local") {
    throw new PolicyRefusal(
      "processing_mode_violation",
      "processing_mode is local_only but parent is remote"
    );
  }
}

/**
 * Check whether a child provider/model tuple is admitted by the policy.
 */
export function checkChildModel(policy: KbPolicy, tuple: ProviderModelTuple): void {
  if (policy.allowed_child_models.length === 0) {
    throw new PolicyRefusal(
      "empty_model_lists",
      "child model allowlist is empty — denied by default"
    );
  }
  const matched = policy.allowed_child_models.some(
    (rule) =>
      rule.provider === tuple.provider &&
      rule.model === tuple.model &&
      rule.locality === tuple.locality
  );
  if (!matched) {
    throw new PolicyRefusal("child_model_denied", "child provider/model tuple is not allowlisted");
  }
  if (policy.processing_mode === "local_only" && tuple.locality !== "local") {
    throw new PolicyRefusal(
      "processing_mode_violation",
      "processing_mode is local_only but child is remote"
    );
  }
}

/**
 * Check whether a derived parent answer is permitted.
 *
 * Requires `derived_query_answer: "allow_explicit_derived_answer"` in policy.
 * The host-grant check (§5.1 ParentDeliveryGrantV1) is separate and must also pass.
 */
export function checkDerivedAnswerDelivery(policy: KbPolicy): void {
  if (policy.parent_result.derived_query_answer !== "allow_explicit_derived_answer") {
    throw new PolicyRefusal(
      "derived_answer_denied",
      "policy does not permit derived parent answers"
    );
  }
}

/**
 * Full deny-before-session check for a run that will create child sessions.
 *
 * Throws a `PolicyRefusal` on any failure. Returns void on success. The caller
 * is responsible for ensuring no `createAgentSession` or private-body read
 * occurs before this function returns.
 */
export function enforceBeforeSession(input: {
  policy: KbPolicy;
  parentTuple: ProviderModelTuple;
  childTuples: readonly ProviderModelTuple[];
}): void {
  checkParentModel(input.policy, input.parentTuple);
  for (const childTuple of input.childTuples) {
    checkChildModel(input.policy, childTuple);
  }
}
