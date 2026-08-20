/**
 * KB policy enforcement tests (G7, §5.3).
 */

import { describe, expect, it } from "vitest";

import {
  checkChildModel,
  checkChildModelIdentity,
  checkDerivedAnswerDelivery,
  checkParentModel,
  checkParentModelIdentity,
  enforceBeforeSession,
  PolicyRefusal,
  type ProviderModelTuple,
} from "../src/kb/policy.js";
import { defaultDenyPolicy, type KbPolicy } from "../src/kb/contracts.js";

const LOCAL: ProviderModelTuple = {
  provider: "ollama",
  model: "qwen3.8:latest",
  locality: "local",
};

const REMOTE: ProviderModelTuple = {
  provider: "openai",
  model: "gpt-4",
  locality: "remote",
};

function policyWith(overrides: Partial<KbPolicy>): KbPolicy {
  return { ...defaultDenyPolicy("kb_001"), ...overrides };
}

describe("KB §5.3 deny-before-session", () => {
  it("denies everything with the default-deny policy (empty lists)", () => {
    const policy = defaultDenyPolicy("kb_001");
    expect(() => checkParentModel(policy, LOCAL)).toThrow(PolicyRefusal);
    expect(() => checkChildModel(policy, LOCAL)).toThrow(PolicyRefusal);
  });

  it("admits a local parent when allowlisted under local_only", () => {
    const policy = policyWith({
      processing_mode: "local_only",
      allowed_parent_models: [{ ...LOCAL }],
    });
    expect(() => checkParentModel(policy, LOCAL)).not.toThrow();
  });

  it("denies a remote parent under local_only", () => {
    const policy = policyWith({
      processing_mode: "local_only",
      allowed_parent_models: [{ ...REMOTE, locality: "local" }],
    });
    expect(() => checkParentModel(policy, REMOTE)).toThrow(PolicyRefusal);
  });

  it("admits a remote parent under provider_permitted", () => {
    const policy = policyWith({
      processing_mode: "provider_permitted",
      allowed_parent_models: [{ ...REMOTE }],
    });
    expect(() => checkParentModel(policy, REMOTE)).not.toThrow();
  });

  it("denies a parent not in the allowlist", () => {
    const policy = policyWith({
      allowed_parent_models: [{ provider: "other", model: "x", locality: "local" }],
    });
    expect(() => checkParentModel(policy, LOCAL)).toThrow(PolicyRefusal);
  });

  it("admits local children when allowlisted", () => {
    const policy = policyWith({
      processing_mode: "local_only",
      allowed_child_models: [{ ...LOCAL }],
    });
    expect(() => checkChildModel(policy, LOCAL)).not.toThrow();
  });

  it("enforceBeforeSession checks parent then every child", () => {
    const policy = policyWith({
      processing_mode: "local_only",
      allowed_parent_models: [{ ...LOCAL }],
      allowed_child_models: [{ ...LOCAL }],
    });
    expect(() =>
      enforceBeforeSession({ policy, parentTuple: LOCAL, childTuples: [LOCAL, LOCAL] })
    ).not.toThrow();
  });

  it("enforceBeforeSession fails on the first bad child", () => {
    const policy = policyWith({
      processing_mode: "local_only",
      allowed_parent_models: [{ ...LOCAL }],
      allowed_child_models: [{ ...LOCAL }],
    });
    expect(() =>
      enforceBeforeSession({ policy, parentTuple: LOCAL, childTuples: [LOCAL, REMOTE] })
    ).toThrow(PolicyRefusal);
  });
});

describe("KB §5.3 derived answer delivery", () => {
  it("denies by default (default-deny policy)", () => {
    const policy = defaultDenyPolicy("kb_001");
    expect(() => checkDerivedAnswerDelivery(policy)).toThrow(PolicyRefusal);
  });

  it("admits when explicitly allowed", () => {
    const policy = policyWith({
      parent_result: {
        derived_query_answer: "allow_explicit_derived_answer",
        max_utf8_bytes: 16384,
      },
    });
    expect(() => checkDerivedAnswerDelivery(policy)).not.toThrow();
  });
});

describe("§5.3 identity-based admission (resolved tuples, never aliases)", () => {
  const PARENT = { provider: "ollama", model: "qwen327b:latest" };
  const base = (over: Partial<KbPolicy> = {}): KbPolicy => ({
    ...defaultDenyPolicy("kbp-identity"),
    allowed_parent_models: [{ ...PARENT, locality: "local" }],
    allowed_child_models: [{ ...PARENT, locality: "local" }],
    ...over,
  });

  it("admits an exact parent/child identity and reads locality from the operator's rule", () => {
    expect(() => checkParentModelIdentity(base(), PARENT)).not.toThrow();
    expect(() => checkChildModelIdentity(base(), PARENT)).not.toThrow();
  });

  it("denies empty allowlists, unknown tuples, and incomplete identities", () => {
    for (const check of [checkParentModelIdentity, checkChildModelIdentity]) {
      expect(() =>
        check(base({ allowed_parent_models: [], allowed_child_models: [] }), PARENT)
      ).toThrow(PolicyRefusal);
      expect(() => check(base(), { provider: "anthropic", model: "claude-x" })).toThrow(
        PolicyRefusal
      );
      expect(() => check(base(), { provider: "", model: "x" })).toThrow(PolicyRefusal);
      expect(() => check(base(), { provider: "ollama", model: "" })).toThrow(PolicyRefusal);
    }
  });

  it("enforces local_only against the matched rule's declared locality", () => {
    const remote = base({
      processing_mode: "local_only",
      allowed_parent_models: [{ ...PARENT, locality: "remote" }],
      allowed_child_models: [{ ...PARENT, locality: "remote" }],
    });
    expect(() => checkParentModelIdentity(remote, PARENT)).toThrow(/local_only/);
    expect(() => checkChildModelIdentity(remote, PARENT)).toThrow(/local_only/);
  });

  it("does not admit a near-miss (provider or model differing by one segment)", () => {
    expect(() =>
      checkParentModelIdentity(base(), { provider: "ollama", model: "qwen327b" })
    ).toThrow(PolicyRefusal);
    expect(() =>
      checkChildModelIdentity(base(), { provider: "ollama2", model: "qwen327b:latest" })
    ).toThrow(PolicyRefusal);
  });
});
