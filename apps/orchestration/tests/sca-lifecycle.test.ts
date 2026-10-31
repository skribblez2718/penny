import { describe, expect, it } from "vitest";

import { ContractValidationError } from "../dist/contracts.js";
import { validateFindingRecord } from "../dist/sca/contracts.js";
import {
  CLAIM_TRANSITIONS,
  FINDING_TRANSITIONS,
  TASK_TRANSITIONS,
  transitionClaimRecord,
  transitionFindingRecord,
  transitionTaskRecord,
} from "../dist/sca/lifecycle.js";
import { requireValue } from "./helpers/narrowing.js";
import { createValidScaDomainFixture } from "./helpers/sca-domain-fixtures.js";

function schemaIssues(validate: () => unknown): readonly string[] {
  try {
    validate();
  } catch (error) {
    if (error instanceof ContractValidationError) return error.issues;
    throw error;
  }
  throw new Error("expected malformed SCA input to fail schema validation");
}

describe("S-01 append-only lifecycle transitions", () => {
  it("accepts pending/active, draft/asserted, and candidate/investigating/terminal histories", () => {
    using fixture = createValidScaDomainFixture();
    const { bundle } = fixture;
    const taskV1 = requireValue(bundle.tasks[0], "task v1");
    const taskV2 = requireValue(bundle.tasks[1], "task v2");
    const taskV3 = requireValue(bundle.tasks[2], "task v3");
    const claimV1 = requireValue(bundle.claims[0], "claim v1");
    const claimV2 = requireValue(bundle.claims[1], "claim v2");
    const claimV3 = requireValue(bundle.claims[2], "claim v3");
    const findingV1 = requireValue(bundle.findings[0], "finding v1");
    const findingV2 = requireValue(bundle.findings[1], "finding v2");
    const findingV3 = requireValue(bundle.findings[2], "finding v3");

    expect(TASK_TRANSITIONS.completed).toEqual([]);
    expect(CLAIM_TRANSITIONS.rejected).toEqual([]);
    expect(FINDING_TRANSITIONS.candidate).toEqual(["investigating"]);
    expect(FINDING_TRANSITIONS.rejected_with_evidence).toEqual([]);
    expect(transitionTaskRecord(taskV1, taskV2)).toEqual(taskV2);
    expect(transitionTaskRecord(taskV2, taskV3)).toEqual(taskV3);
    expect(transitionClaimRecord(claimV1, claimV2)).toEqual(claimV2);
    expect(transitionClaimRecord(claimV2, claimV3)).toEqual(claimV3);
    expect(transitionFindingRecord(findingV1, findingV2)).toEqual(findingV2);
    expect(transitionFindingRecord(findingV2, findingV3)).toEqual(findingV3);
  });

  it("rejects direct candidate-to-terminal and other skipped or backward transitions", () => {
    using fixture = createValidScaDomainFixture();
    const { bundle } = fixture;
    const taskV1 = requireValue(bundle.tasks[0], "task v1");
    const claimV1 = requireValue(bundle.claims[0], "claim v1");
    const findingV1 = requireValue(bundle.findings[0], "finding v1");
    const findingV2 = requireValue(bundle.findings[1], "finding v2");

    expect(() =>
      transitionTaskRecord(taskV1, {
        ...taskV1,
        status: "completed",
        decision_id: "decision-task-complete",
        version: 2,
        sequence: 2,
        updated_at: "2026-09-16T00:00:02Z",
      })
    ).toThrow(/illegal transition/u);
    expect(() =>
      transitionClaimRecord(claimV1, {
        ...claimV1,
        status: "accepted",
        decision_id: "decision-claim-accept",
        version: 2,
        sequence: 5,
        updated_at: "2026-09-16T00:00:05Z",
      })
    ).toThrow(/illegal transition/u);
    expect(() =>
      transitionFindingRecord(findingV1, {
        ...findingV2,
        status: "confirmed",
        decision_id: "decision-finding-confirm",
        version: 2,
        sequence: 9,
        updated_at: "2026-09-16T00:00:09Z",
      })
    ).toThrow(/illegal transition/u);
    expect(() => transitionFindingRecord(findingV1, { ...findingV2, evidence_ids: [] })).toThrow(
      /discriminating claim or evidence/u
    );
  });

  it("rejects every mutation after a terminal state", () => {
    using fixture = createValidScaDomainFixture();
    const terminalTask = requireValue(fixture.bundle.tasks[2], "terminal task");
    const terminalClaim = requireValue(fixture.bundle.claims[2], "terminal claim");
    const terminalFinding = requireValue(fixture.bundle.findings[2], "terminal finding");

    expect(() =>
      transitionTaskRecord(terminalTask, {
        ...terminalTask,
        status: "rejected",
        version: 4,
        sequence: 15,
        updated_at: "2026-09-16T00:00:15Z",
      })
    ).toThrow(/terminal/u);
    expect(() =>
      transitionClaimRecord(terminalClaim, {
        ...terminalClaim,
        status: "rejected",
        version: 4,
        sequence: 15,
        updated_at: "2026-09-16T00:00:15Z",
      })
    ).toThrow(/terminal/u);
    expect(() =>
      transitionFindingRecord(terminalFinding, {
        ...terminalFinding,
        status: "rejected_with_evidence",
        version: 4,
        sequence: 15,
        updated_at: "2026-09-16T00:00:15Z",
      })
    ).toThrow(/terminal/u);
  });

  it("enforces exact version, sequence, and nanosecond timestamp monotonicity", () => {
    using fixture = createValidScaDomainFixture();
    const taskV1 = requireValue(fixture.bundle.tasks[0], "task v1");
    const taskV2 = requireValue(fixture.bundle.tasks[1], "task v2");

    expect(() => transitionTaskRecord(taskV1, { ...taskV2, version: 3 })).toThrow(/version/u);
    expect(() => transitionTaskRecord(taskV1, { ...taskV2, sequence: 1 })).toThrow(/sequence/u);
    expect(() =>
      transitionTaskRecord(taskV1, { ...taskV2, updated_at: taskV1.updated_at })
    ).toThrow(/updated_at/u);
    const nanosV1 = {
      ...taskV1,
      created_at: "2026-09-16T00:00:00.000000002Z",
      updated_at: "2026-09-16T00:00:00.000000002Z",
    };
    const nanosV2 = {
      ...taskV2,
      created_at: nanosV1.created_at,
      updated_at: "2026-09-16T00:00:00.000000001Z",
    };
    expect(() => transitionTaskRecord(nanosV1, nanosV2)).toThrow(/never precede|increase/u);
  });

  it("preserves project/phase identity and append-only evidence/claim references", () => {
    using fixture = createValidScaDomainFixture();
    const claimV1 = requireValue(fixture.bundle.claims[0], "claim v1");
    const claimV2 = requireValue(fixture.bundle.claims[1], "claim v2");
    const findingV1 = requireValue(fixture.bundle.findings[0], "finding v1");
    const findingV2 = requireValue(fixture.bundle.findings[1], "finding v2");

    expect(() =>
      transitionClaimRecord(claimV1, { ...claimV2, project_id: `prj_${"4".repeat(32)}` })
    ).toThrow(/immutable/u);
    expect(() => transitionClaimRecord(claimV1, { ...claimV2, phase_id: "other-phase" })).toThrow(
      /immutable/u
    );
    expect(() =>
      transitionClaimRecord(claimV1, { ...claimV2, statement: "Mutated assertion." })
    ).toThrow(/immutable/u);
    expect(() => transitionClaimRecord(claimV1, { ...claimV2, evidence_ids: [] })).toThrow(
      /append-only/u
    );
    expect(
      schemaIssues(() => transitionFindingRecord(findingV1, { ...findingV2, claim_ids: [] }))
    ).toContain("/claim_ids: minItems constraint failed");
  });

  it("rejects schema-valid nonempty finding claim contractions at append-only comparison", () => {
    using fixture = createValidScaDomainFixture();
    const findingV1 = requireValue(fixture.bundle.findings[0], "finding v1");
    const findingV2 = requireValue(fixture.bundle.findings[1], "finding v2");
    const previous = validateFindingRecord({
      ...findingV1,
      claim_ids: [...findingV1.claim_ids, "claim-secondary"],
    });
    const contracted = validateFindingRecord(findingV2);
    expect(previous.claim_ids).toHaveLength(2);
    expect(contracted.claim_ids).toHaveLength(1);
    const retained = validateFindingRecord({ ...contracted, claim_ids: previous.claim_ids });
    expect(transitionFindingRecord(previous, retained)).toEqual(retained);
    expect(() => transitionFindingRecord(previous, contracted)).toThrow(
      "SCA finding transition claim_ids failed validation: reference list must be append-only and retain its original order"
    );
  });
});
