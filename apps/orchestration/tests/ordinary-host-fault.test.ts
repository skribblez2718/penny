import path from "node:path";

import { describe, expect, it } from "vitest";

import { RunContext } from "../dist/context.js";
import { StartRequestSchema, validateContract } from "../dist/contracts.js";
import { initializePennyState } from "../dist/state/setup.js";
import { OrchestrationEngine } from "../dist/engine.js";
import { OrchestrationService } from "../dist/service.js";
import {
  PLAYBOOK_REGISTRY,
  runtimeRegistrationSha256,
  validateRegistrationContract,
  withOrdinaryFaultConstructor,
  type OrdinaryHostFaultPointV1,
} from "../dist/playbooks/registry.js";
import { ASSESS_PLAYBOOK_REGISTRATION } from "../dist/playbooks/assess.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";
import { sealPolicySha256, validateSealPolicy } from "../dist/skill-contracts/sealing.js";
import { Checkpointer } from "../dist/checkpointer.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const projectRoot = path.resolve(import.meta.dirname, "../../..");
const names = ["assess", "decide", "define", "diagnose", "plan", "produce", "research"] as const;

describe("ordinary host-only fault injection", () => {
  it("wires all seven active registrations, preserving phase and pre/post commit boundaries", () => {
    for (const name of names) {
      const registration = PLAYBOOK_REGISTRY.get(name);
      if (registration === undefined) throw new Error(`missing ${name} registration`);
      const observed: OrdinaryHostFaultPointV1[] = [];
      const playbook = registration.construct({ hostFault: (event) => observed.push(event) });
      const context = RunContext.create({
        identity: {
          schema_version: 2,
          run_id: "run-host-fault",
          session_id: "session-host-fault",
          playbook: name,
          engine_owner: "typescript",
        },
        goal: "Test host wiring",
        constraints: {},
        projectRoot,
        trustProfile: "trusted-interactive",
        maxSteps: 24,
      });
      const before =
        name === "research"
          ? "sealing_core:artifact-persistence"
          : "sealing_product:artifact-persistence";
      playbook.hostCheckpointCommitted?.(context, before);
      const after =
        name === "research"
          ? "rendering:final-checkpoint-admission"
          : "admitting_product:completion-admission";
      playbook.hostCheckpointCommitted?.(context, after);
      expect(observed).toEqual([
        {
          skill: name,
          phase: before.split(":")[0],
          point: before,
          boundary: "before_checkpoint_commit",
        },
        {
          skill: name,
          phase: after.split(":")[0],
          point: after,
          boundary: "after_checkpoint_commit",
        },
      ]);
      expect(() =>
        registration.construct({ hostFault: () => undefined, researchHostFault: () => undefined })
      ).toThrow(/ambiguous host fault hooks/);
      expect(runtimeRegistrationSha256(registration)).toBe(
        runtimeRegistrationSha256({ ...registration, construct: () => playbook })
      );
    }
  });

  it("binds an opt-in policy without changing any unadopted registration digest", () => {
    const registration = PLAYBOOK_REGISTRY.get("assess");
    if (registration === undefined) throw new Error("missing assess registration");
    const baseline = runtimeRegistrationSha256(registration);
    const policy = validateSealPolicy({
      schema_id: "penny.seal-policy.v1",
      schema_version: 1,
      skill: "assess",
      draft_phase: "authoring_assessment",
      seal_phase: "sealing_assessment",
      draft_schema: "penny.assessment-draft.v2",
      draft_schema_version: 2,
      draft_kind: "assessment-draft",
      product_kind: "semantic-core",
      correction_limit: null,
      diagnostic_schema: "penny.seal-diagnostic.v1",
    });
    expect(sealPolicySha256(policy)).toMatch(/^[a-f0-9]{64}$/u);
    expect(runtimeRegistrationSha256({ ...registration, seal_policy: policy })).toBe(baseline);
    expect(
      runtimeRegistrationSha256({
        ...registration,
        seal_policy: { ...policy, correction_limit: 1 },
      })
    ).not.toBe(baseline);
    expect(validateRegistrationContract({ ...registration, seal_policy: policy })).toBe(
      registration.contract
    );
    expect(() =>
      validateRegistrationContract({ ...registration, seal_policy: { ...policy, skill: "other" } })
    ).toThrow(/seal policy skill/);
    expect(runtimeRegistrationSha256(registration)).toBe(baseline);
  });

  it("keeps the Research-only callback byte-for-byte compatible and supports explicit base registration construction", () => {
    const research = PLAYBOOK_REGISTRY.get("research");
    if (research === undefined) throw new Error("missing research registration");
    const points: string[] = [];
    const playbook = research.construct({ researchHostFault: (point) => points.push(point) });
    const context = RunContext.create({
      identity: {
        schema_version: 2,
        run_id: "run-research-legacy",
        session_id: "session-research-legacy",
        playbook: "research",
        engine_owner: "typescript",
      },
      goal: "Research test",
      constraints: {},
      projectRoot,
      trustProfile: "trusted-interactive",
      maxSteps: 24,
    });
    playbook.hostCheckpointCommitted?.(context, "rendering:final-checkpoint-admission");
    expect(points).toEqual(["rendering:final-checkpoint-admission"]);
    expect(
      runtimeRegistrationSha256(withOrdinaryFaultConstructor(ASSESS_PLAYBOOK_REGISTRATION))
    ).toBe(runtimeRegistrationSha256(ASSESS_PLAYBOOK_REGISTRATION));
    const baseEvents: OrdinaryHostFaultPointV1[] = [];
    const base = withOrdinaryFaultConstructor(ASSESS_PLAYBOOK_REGISTRATION).construct({
      hostFault: (event) => baseEvents.push(event),
    });
    base.hostCheckpointCommitted?.(context, "sealing_assessment:feedback-persistence");
    expect(baseEvents).toEqual([
      {
        skill: "assess",
        phase: "sealing_assessment",
        point: "sealing_assessment:feedback-persistence",
        boundary: "before_checkpoint_commit",
      },
    ]);
  });

  it("threads the callback through a normal service/engine without admitting it as a request field", () => {
    const root = mkdtempSync(path.join(tmpdir(), "penny-host-fault-service-"));
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PENNY_STATE_ROOT: path.join(root, "state"),
        PI_OBSERVABILITY_AUTO_START: "false",
        PI_OBSERVABILITY_ENABLED: "false",
      };
      initializePennyState(projectRoot, { env });
      const active = PLAYBOOK_REGISTRY.get("assess");
      if (active === undefined) throw new Error("missing assess registration");
      const events: OrdinaryHostFaultPointV1[] = [];
      const registration = {
        ...active,
        construct: (options: Parameters<typeof active.construct>[0]) => {
          const playbook = active.construct(options);
          const context = RunContext.create({
            identity: {
              schema_version: 2,
              run_id: "run-service-host-fault",
              session_id: "session-service-host-fault",
              playbook: "assess",
              engine_owner: "typescript",
            },
            goal: "Check normal host seam",
            constraints: {},
            projectRoot,
            trustProfile: "trusted-interactive",
            maxSteps: 24,
          });
          playbook.hostCheckpointCommitted?.(context, "sealing_assessment:artifact-persistence");
          return playbook;
        },
      };
      using service = new OrchestrationService({
        projectRoot,
        env,
        playbookRegistration: registration,
        modelClient: { runAgent: () => Promise.reject(new Error("model must not run")) },
        hostFault: (event) => events.push(event),
      });
      expect(service.engine.registration.name).toBe("assess");
      expect(events).toEqual([
        {
          skill: "assess",
          phase: "sealing_assessment",
          point: "sealing_assessment:artifact-persistence",
          boundary: "before_checkpoint_commit",
        },
      ]);
      const start = {
        schema_version: 2,
        action: "start",
        identity: {
          schema_version: 2,
          run_id: "run-untrusted-hook",
          session_id: "session-untrusted-hook",
          playbook: "assess",
          engine_owner: "typescript",
        },
        goal: "Check closed request",
        constraints: {},
        project_root: projectRoot,
        trust_profile: "trusted-interactive",
      };
      expect(validateContract(StartRequestSchema, start, "host fault start")).toEqual(start);
      expect(() =>
        validateContract(
          StartRequestSchema,
          { ...start, hostFault: "sealing_assessment:artifact-persistence" },
          "host fault start"
        )
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses dual hooks before engine/service work", () => {
    const root = mkdtempSync(path.join(tmpdir(), "penny-host-fault-dual-"));
    try {
      const checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
      try {
        expect(
          () =>
            new OrchestrationEngine(checkpointer, {
              projectRoot: root,
              maxSteps: 24,
              receiptAuthority: TEST_RECEIPT_AUTHORITY,
              hostFault: () => undefined,
              researchHostFault: () => undefined,
            })
        ).toThrow(/ambiguous host fault hooks/);
      } finally {
        checkpointer.close();
      }
      expect(
        () =>
          new OrchestrationService({
            projectRoot,
            hostFault: () => undefined,
            researchHostFault: () => undefined,
          })
      ).toThrow(/ambiguous host fault hooks/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
