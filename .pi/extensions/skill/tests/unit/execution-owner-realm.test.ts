/**
 * Skill Extension Unit Tests — execution-owner realm singleton
 *
 * Regression coverage for the P0 human-gate deadlock.
 *
 * pi loads every extension through its OWN jiti instance with `moduleCache: false`
 * (pi-coding-agent `dist/core/extensions/loader.js::loadExtensionModule`). The skill
 * extension and the questionnaire extension both import `execution-receipts.ts`, so
 * they received TWO module instances with SEPARATE module-level state:
 *
 *   - separate transport registries -> "Trusted questionnaire capability is invalid
 *     or stale" on every gate answer;
 *   - separate owner keys -> the questionnaire would sign trusted_human_event with a
 *     different key than the one handed to the Python orchestrator, so even a shared
 *     registry would then fail as "signature is missing or invalid".
 *
 * Every P0 gate was therefore unsatisfiable, which blocked every standalone code-skill
 * run (ideal_state_from_goal emits schema_version 2 => P0).
 *
 * The ordinary suite CANNOT observe this: vitest shares one module graph, so a plain
 * import/register/resolve round-trip passes even when the bug is fully present. These
 * tests deliberately evaluate the module MORE THAN ONCE to simulate the loader's
 * per-extension isolation.
 */

import { describe, it, expect } from "vitest";

const MODULE_PATH = "../../execution-receipts.js";

/**
 * Evaluate execution-receipts.ts as a FRESH module instance.
 *
 * A distinct query string defeats the ESM/vitest module cache, which is exactly what
 * jiti's `moduleCache: false` does to us in production. Without the realm singleton
 * each of these would carry its own key and its own registry.
 */
async function freshInstance(tag: string) {
  return (await import(/* @vite-ignore */ `${MODULE_PATH}?realm-instance=${tag}`)) as typeof import("../../execution-receipts.js");
}

describe("execution-owner realm singleton", () => {
  it("shares ONE owner key across independently evaluated module instances", async () => {
    const a = await freshInstance("key-a");
    const b = await freshInstance("key-b");

    // The key is never exposed directly; withExecutionOwnerEnvironment is the only
    // sanctioned way it leaves the module, and it is what the Python child receives.
    const envA = a.withExecutionOwnerEnvironment({});
    const envB = b.withExecutionOwnerEnvironment({});

    expect(envA.PENNY_RECEIPT_HMAC_KEY).toBeTruthy();
    expect(envA.PENNY_RECEIPT_HMAC_KEY).toMatch(/^[0-9a-f]{64}$/);
    // THE assertion: two instances, one identity. Before the realm fix these differed,
    // so the questionnaire signed with a key Python would reject.
    expect(envB.PENNY_RECEIPT_HMAC_KEY).toBe(envA.PENNY_RECEIPT_HMAC_KEY);
    expect(envB.PENNY_APPROVAL_HMAC_KEY).toBe(envA.PENNY_APPROVAL_HMAC_KEY);
  });

  it("resolves a capability registered by a DIFFERENT module instance", async () => {
    // This is the exact production path: skill extension registers, questionnaire
    // extension resolves.
    const skillSide = await freshInstance("register-side");
    const questionnaireSide = await freshInstance("resolve-side");

    const artifactRef = {
      artifact_id: "ideal-realm",
      kind: "ideal_state_revision",
      version: 1,
      digest: "e".repeat(64),
    };
    const transportRef = {
      artifact_id: "transport-realm",
      kind: "questionnaire_transport",
      version: 1,
      digest: "f".repeat(64),
    };
    const questions = [
      {
        id: "criteria_refinement",
        label: "Criteria Fix",
        prompt: "Approve the exact selected artifact?",
        options: [{ value: "accept", label: "Accept as-is" }],
        allowOther: true,
      },
    ];
    const binding = {
      runId: "run-realm",
      gateId: "criteria_gate",
      challenge: "challenge-realm",
      artifactRef,
      transportRef,
      renderedQuestionsDigest: skillSide.renderedQuestionsDigest(questions),
    };

    const capability = skillSide.registerTrustedQuestionnaireTransport(questions, binding);
    expect(capability).toBeTruthy();

    // Cross-instance resolve — undefined before the realm fix.
    const resolved = questionnaireSide.resolveTrustedQuestionnaireTransport(capability as string);
    expect(resolved).toBeDefined();
    expect(resolved?.binding.challenge).toBe("challenge-realm");
    expect(resolved?.questions).toEqual(questions);
  });

  it("honours one-time consumption across module instances", async () => {
    const registrar = await freshInstance("consume-register");
    const consumer = await freshInstance("consume-resolve");

    const questions = [
      { id: "plan", label: "Plan", prompt: "Approve?", options: [], allowOther: true },
    ];
    const binding = {
      runId: "run-consume",
      gateId: "plan_gate",
      challenge: "challenge-consume",
      artifactRef: { artifact_id: "p", kind: "piper_plan", version: 1, digest: "a".repeat(64) },
      transportRef: {
        artifact_id: "t",
        kind: "questionnaire_transport",
        version: 1,
        digest: "b".repeat(64),
      },
      renderedQuestionsDigest: registrar.renderedQuestionsDigest(questions),
    };

    const capability = registrar.registerTrustedQuestionnaireTransport(questions, binding) as string;
    expect(consumer.resolveTrustedQuestionnaireTransport(capability)).toBeDefined();

    consumer.consumeTrustedQuestionnaireTransport(capability);

    // Consumed on one instance must be consumed on ALL of them — otherwise a capability
    // could be redeemed twice by alternating instances.
    expect(consumer.resolveTrustedQuestionnaireTransport(capability)).toBeUndefined();
    expect(registrar.resolveTrustedQuestionnaireTransport(capability)).toBeUndefined();
  });
});
