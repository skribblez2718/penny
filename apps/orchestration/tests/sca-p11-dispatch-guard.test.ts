import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import type { ArtifactRef, StartRequest } from "../dist/contracts.js";
import { RunContext } from "../dist/context.js";
import { resolveProviderOpeningGuard } from "../dist/provider-opening-guard.js";
import {
  SCA_P11_CANDIDATE_PLAYBOOK_NAME,
  ScaP11CandidatePlaybook,
  buildScaP11CandidateRegistrationWithBindingV1,
} from "../dist/sca/p11-playbook.js";
import { SCA_P11_QUALIFIED_CVSS_FIXTURE } from "../dist/sca/p11-scoring.js";
import {
  SCA_P11_PROVIDER_OPENING_ADAPTER,
  authorizeScaP11SerializedOpening,
  buildScaP11InlineOpeningAppendix,
} from "../dist/sca/p11-dispatch-guard.js";
import {
  SCA_P11_PROVIDER_OPENING_GUARD,
  SCA_P11_REPAIRING_STATE,
  SCA_P11_REVIEWER_AGENT,
  SCA_P11_REVIEWING_STATE,
} from "../dist/sca/p11-contracts.js";
import { buildScaP11Lineage, slotsForP11, P11_PROJECT_ROOT } from "./sca-p11-lineage.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SCA P11 provider opening guard", () => {
  it("authorizes the exact serialized payload and refuses a drifted opening", () => {
    const root = mkdtempSync(path.join(tmpdir(), "penny-p11-guard-"));
    roots.push(root);
    const artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const runId = "run-p11-guard";
    const lineage = buildScaP11Lineage({
      store: artifacts,
      run_id: runId,
      confirmed: true,
      accepted: true,
      report_policy_complete: true,
    });
    const registration = buildScaP11CandidateRegistrationWithBindingV1({
      scorer: SCA_P11_QUALIFIED_CVSS_FIXTURE,
    });
    const startAdmission = registration.start_admission;
    if (startAdmission === undefined) throw new Error("P11 start admission is absent");
    const request: StartRequest = {
      schema_version: 2,
      action: "start",
      identity: {
        schema_version: 2,
        run_id: runId,
        session_id: `session-${runId}`,
        playbook: SCA_P11_CANDIDATE_PLAYBOOK_NAME,
        engine_owner: "typescript",
      },
      goal: "Exercise the inactive P11 provider opening guard.",
      constraints: lineage.constraints,
      project_root: P11_PROJECT_ROOT,
      trust_profile: "hardened-untrusted",
      input_artifacts: { schema_version: 2, artifacts: slotsForP11(lineage.constraints) },
    };
    const prepared = startAdmission.prepare(request, {});
    const refs = startAdmission.materialize(prepared, {
      run_id: runId,
      artifactStore: artifacts,
      trustedClock: () => new Date("2026-10-02T00:00:06.000Z"),
    });
    const run = RunContext.create({
      identity: request.identity,
      goal: request.goal,
      constraints: {},
      projectRoot: P11_PROJECT_ROOT,
      trustProfile: "hardened-untrusted",
      maxSteps: 8,
      initialArtifacts: refs,
    });
    const playbook = new ScaP11CandidatePlaybook(artifacts, {
      scorer: SCA_P11_QUALIFIED_CVSS_FIXTURE,
    });
    playbook.initialize(run);
    const reportRef = [...run.selectedArtifacts]
      .reverse()
      .find((r) => r.kind === "sca-p11-report-json");
    if (reportRef === undefined) throw new Error("report ref absent");
    const payloadRef = artifacts.refFor(
      runId,
      SCA_P11_REVIEWING_STATE,
      null,
      "sca-p11-cognitive-payload",
      "sca-p11-review-payload-000001",
      1
    );
    const disclosureRef = artifacts.refFor(
      runId,
      SCA_P11_REVIEWING_STATE,
      null,
      "sca-p11-disclosure-admission",
      "sca-p11-review-disclosure-000001",
      1
    );
    if (payloadRef === null || disclosureRef === null)
      throw new Error("payload/disclosure ref absent");
    // The adapter is uniquely resolvable for both declared cognitive states.
    const resolved = resolveProviderOpeningGuard({
      id: SCA_P11_PROVIDER_OPENING_GUARD,
      registration_name: SCA_P11_CANDIDATE_PLAYBOOK_NAME,
      state_id: SCA_P11_REVIEWING_STATE,
      agent: SCA_P11_REVIEWER_AGENT,
      adapters: [SCA_P11_PROVIDER_OPENING_ADAPTER],
    });
    expect(resolved.id).toBe(SCA_P11_PROVIDER_OPENING_GUARD);
    expect(
      SCA_P11_PROVIDER_OPENING_ADAPTER.matches(
        SCA_P11_CANDIDATE_PLAYBOOK_NAME,
        SCA_P11_REPAIRING_STATE,
        SCA_P11_REVIEWER_AGENT
      )
    ).toBe(true);
    expect(
      SCA_P11_PROVIDER_OPENING_ADAPTER.matches(
        "sca-p10-candidate",
        SCA_P11_REVIEWING_STATE,
        SCA_P11_REVIEWER_AGENT
      )
    ).toBe(false);

    const assignment = {
      registration_name: SCA_P11_CANDIDATE_PLAYBOOK_NAME,
      run_id: runId,
      state_id: SCA_P11_REVIEWING_STATE,
      branch_id: null,
      agent: SCA_P11_REVIEWER_AGENT,
      task: "Review the exact report assertions.",
      input_artifacts: {
        schema_version: 2 as const,
        artifacts: [
          { slot: "cognitive_payload", ref: payloadRef as ArtifactRef },
          { slot: "disclosure_admission", ref: disclosureRef as ArtifactRef },
        ],
      },
    };
    const appendix = buildScaP11InlineOpeningAppendix({ store: artifacts, assignment });
    const opening = `Host task preamble.\n\n${appendix}\n\nReturn the complete stage output\n`;
    const authorization = authorizeScaP11SerializedOpening({
      store: artifacts,
      assignment,
      opening,
    });
    expect(authorization.payload_ref.artifact_id).toBe(payloadRef.artifact_id);
    expect(authorization.disclosure_ref.artifact_id).toBe(disclosureRef.artifact_id);
    const tamperedAppendix = buildScaP11InlineOpeningAppendix({
      store: artifacts,
      assignment: { ...assignment, task: "A different task." },
    });
    expect(() =>
      authorizeScaP11SerializedOpening({
        store: artifacts,
        assignment,
        opening: `Host task preamble.\n\n${tamperedAppendix}\n\nReturn the complete stage output\n`,
      })
    ).toThrow();
    expect(() =>
      authorizeScaP11SerializedOpening({
        store: artifacts,
        assignment: { ...assignment, state_id: SCA_P11_REPAIRING_STATE },
        opening,
      })
    ).toThrow();
  }, 30000);
});
