import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson } from "../dist/canonical-json.js";
import type { ArtifactRef, Directive, InputArtifacts, StartRequest } from "../dist/contracts.js";
import { RunContext } from "../dist/context.js";
import {
  SCA_P08_ASSESSING_STATE,
  SCA_P08_DISCLOSURE_ADMISSION_SCHEMA,
  SCA_P08_PROVIDER_OPENING_GUARD,
  validateScaP08DisclosureAdmissionV1,
  withP08Digest,
} from "../dist/sca/p08-contracts.js";
import {
  SCA_P08_PROVIDER_OPENING_ADAPTER,
  authorizeScaP08SerializedOpening,
  buildScaP08InlineOpeningAppendix,
} from "../dist/sca/p08-dispatch-guard.js";
import {
  isProviderOpeningGuardId,
  resolveProviderOpeningGuard,
} from "../dist/provider-opening-guard.js";
import {
  SCA_P08_CANDIDATE_PLAYBOOK_NAME,
  SCA_P08_CANDIDATE_REGISTRATION,
  ScaP08CandidatePlaybook,
} from "../dist/sca/p08-playbook.js";
import { buildScaP08Lineage, scaP08StartRequest, type ScaP08LineageV1 } from "./sca-p08-lineage.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const TASK = "Assess dispositions.";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p08-guard-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}
function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is absent`);
  return value;
}
function readJson(artifacts: ArtifactStore, ref: ArtifactRef): unknown {
  return JSON.parse(artifacts.readById(ref.artifact_id).toString("utf8"));
}
function start(
  artifacts: ArtifactStore,
  lineage: ScaP08LineageV1
): { readonly run: RunContext; readonly directive: Directive } {
  const startAdmission = required(
    SCA_P08_CANDIDATE_REGISTRATION.start_admission,
    "P08 start admission"
  );
  const request = scaP08StartRequest(lineage);
  const startRequest: StartRequest = {
    schema_version: 2,
    action: "start",
    identity: request.identity,
    goal: request.goal,
    constraints: request.constraints,
    project_root: PROJECT_ROOT,
    trust_profile: "hardened-untrusted",
    input_artifacts: request.inputArtifacts,
  };
  const prepared = startAdmission.prepare(startRequest, {});
  const refs = startAdmission.materialize(prepared, {
    run_id: lineage.run_id,
    artifactStore: artifacts,
    trustedClock: () => new Date("2026-09-26T00:00:03.000Z"),
  });
  const run = RunContext.create({
    identity: {
      schema_version: 2,
      run_id: lineage.run_id,
      session_id: `session-${lineage.run_id}`,
      playbook: SCA_P08_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript",
    },
    goal: "Exercise the inactive P08 opening guard.",
    constraints: {},
    projectRoot: PROJECT_ROOT,
    trustProfile: "hardened-untrusted",
    maxSteps: 6,
    initialArtifacts: refs,
  });
  const playbook = new ScaP08CandidatePlaybook(
    artifacts,
    {},
    () => new Date("2026-09-26T00:00:03.000Z")
  );
  return { run, directive: playbook.initialize(run) };
}
function assignment(
  runId: string,
  payloadRef: ArtifactRef,
  disclosureRef: ArtifactRef
): {
  readonly registration_name: string;
  readonly run_id: string;
  readonly state_id: string;
  readonly branch_id: null;
  readonly agent: string;
  readonly task: string;
  readonly input_artifacts: InputArtifacts;
} {
  return {
    registration_name: "sca-p08-candidate",
    run_id: runId,
    state_id: SCA_P08_ASSESSING_STATE,
    branch_id: null,
    agent: "demetri",
    task: TASK,
    input_artifacts: {
      schema_version: 2,
      artifacts: [
        { slot: "cognitive_payload", ref: payloadRef },
        { slot: "disclosure_admission", ref: disclosureRef },
      ],
    },
  };
}

describe("SCA P08 provider opening disclosure guard", () => {
  it("authorizes the exact host-projected opening and rejects a substituted envelope", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-guard",
      kinds: ["source_query"],
    });
    const { run } = start(artifacts, lineage);
    const payloadRef = required(
      run.selectedArtifacts.find((ref) => ref.kind === "sca-p08-cognitive-payload"),
      "assessment payload"
    );
    const disclosureRef = required(
      run.selectedArtifacts.find((ref) => ref.kind === "sca-p08-disclosure-admission"),
      "assessment disclosure"
    );
    const bound = assignment(run.identity.run_id, payloadRef, disclosureRef);
    const appendix = buildScaP08InlineOpeningAppendix({ store: artifacts, assignment: bound });
    const opening = `TASK:\n\n${TASK}\n\n${appendix}\n\nReturn the complete stage output in assistant text.`;
    const authorization = authorizeScaP08SerializedOpening({
      store: artifacts,
      assignment: bound,
      opening,
    });
    expect(authorization.payload_ref.artifact_id).toBe(payloadRef.artifact_id);
    const tampered = opening.replace(
      appendix,
      appendix.replace('"agent":"demetri"', '"agent":"ida"')
    );
    expect(tampered).not.toBe(opening);
    expect(() =>
      authorizeScaP08SerializedOpening({ store: artifacts, assignment: bound, opening: tampered })
    ).toThrow();
    expect(
      SCA_P08_PROVIDER_OPENING_ADAPTER.matches(
        "sca-p08-candidate",
        SCA_P08_ASSESSING_STATE,
        "demetri"
      )
    ).toBe(true);
    expect(
      SCA_P08_PROVIDER_OPENING_ADAPTER.matches(
        "sca-p08-candidate",
        SCA_P08_ASSESSING_STATE,
        "someone-else"
      )
    ).toBe(false);
  });

  it("denies disclosure before dispatch, making zero provider calls and blocking honestly", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-guard-deny",
      kinds: ["source_query"],
      scope_decision: "deny",
    });
    const { run, directive } = start(artifacts, lineage);
    if (directive.action !== "incomplete") throw new Error("expected blocked P08 terminal");
    const terminal = directive.result as Record<string, unknown>;
    expect(terminal["status"]).toBe("blocked");
    expect(terminal["blocker_codes"]).toContain("p08_disclosure_denied_before_dispatch");
    expect(run.selectedArtifacts.some((ref) => ref.kind === "sca-p08-assessment-output")).toBe(
      false
    );
    const payloadRef = required(
      run.selectedArtifacts.find((ref) => ref.kind === "sca-p08-cognitive-payload"),
      "assessment payload"
    );
    const disclosureRef = required(
      run.selectedArtifacts.find((ref) => ref.kind === "sca-p08-disclosure-admission"),
      "assessment disclosure"
    );
    const bound = assignment(run.identity.run_id, payloadRef, disclosureRef);
    const appendix = buildScaP08InlineOpeningAppendix({ store: artifacts, assignment: bound });
    const opening = `TASK:\n\n${TASK}\n\n${appendix}\n\nReturn the complete stage output in assistant text.`;
    expect(() =>
      authorizeScaP08SerializedOpening({ store: artifacts, assignment: bound, opening })
    ).toThrow();
  });

  it("refuses an oversized serialized opening and a drifted guard binding", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-guard-limits",
      kinds: ["source_query"],
    });
    const { run } = start(artifacts, lineage);
    const payloadRef = required(
      run.selectedArtifacts.find((ref) => ref.kind === "sca-p08-cognitive-payload"),
      "assessment payload"
    );
    const disclosureRef = required(
      run.selectedArtifacts.find((ref) => ref.kind === "sca-p08-disclosure-admission"),
      "assessment disclosure"
    );
    const bound = assignment(run.identity.run_id, payloadRef, disclosureRef);
    const appendix = buildScaP08InlineOpeningAppendix({ store: artifacts, assignment: bound });
    const opening = `TASK:\n\n${TASK}\n\n${appendix}\n\nReturn the complete stage output in assistant text.`;
    expect(() =>
      authorizeScaP08SerializedOpening({ store: artifacts, assignment: bound, opening })
    ).not.toThrow();
    // A serialized opening beyond the admitted per-call byte limit is refused before dispatch.
    const oversized = `${opening}${"x".repeat(400_000)}`;
    expect(() =>
      authorizeScaP08SerializedOpening({ store: artifacts, assignment: bound, opening: oversized })
    ).toThrow();
    // A guard whose state/agent binding does not match the declared role is refused.
    expect(() =>
      authorizeScaP08SerializedOpening({
        store: artifacts,
        assignment: { ...bound, agent: "ida" },
        opening,
      })
    ).toThrow();
    // A guard bound to another registration is refused.
    expect(() =>
      authorizeScaP08SerializedOpening({
        store: artifacts,
        assignment: { ...bound, registration_name: "sca-p06-candidate" },
        opening,
      })
    ).toThrow();
  });

  it("refuses a disclosure authorization that omits the payload scope-decision refs", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-guard-projection",
      kinds: ["source_query"],
    });
    const { run } = start(artifacts, lineage);
    const payloadRef = required(
      run.selectedArtifacts.find((ref) => ref.kind === "sca-p08-cognitive-payload"),
      "assessment payload"
    );
    const disclosureRef = required(
      run.selectedArtifacts.find((ref) => ref.kind === "sca-p08-disclosure-admission"),
      "assessment disclosure"
    );
    const disclosure = validateScaP08DisclosureAdmissionV1(readJson(artifacts, disclosureRef));
    const scopeIds = new Set(lineage.admission.scope_decision_refs.map((ref) => ref.artifact_id));
    expect(disclosure.authorized_refs.some((ref) => scopeIds.has(ref.artifact_id))).toBe(true);
    const { admission_sha256: _dropped, ...rest } = disclosure;
    void _dropped;
    const withoutScopeRefs = withP08Digest(
      {
        ...rest,
        authorized_refs: disclosure.authorized_refs.filter((ref) => !scopeIds.has(ref.artifact_id)),
      },
      "admission_sha256"
    );
    const trimmedDisclosureRef = artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: run.identity.run_id,
        phase: SCA_P08_ASSESSING_STATE,
        branch_id: null,
        kind: "sca-p08-disclosure-admission",
        operation_id: "sca-p08-assessment-disclosure-trimmed",
        version: 1,
        producer: "host:test",
        media_type: "application/json",
        content_schema: {
          schema_id: SCA_P08_DISCLOSURE_ADMISSION_SCHEMA,
          schema_version: 1,
        },
        parent_ref: null,
        upstream_refs: [],
      },
      content: canonicalJson(withoutScopeRefs),
    });
    // The trimmed disclosure is itself a valid disclosure admission, but it no longer authorizes
    // the payload's scope-decision refs, so the opening guard refuses the projection.
    const bound = assignment(run.identity.run_id, payloadRef, trimmedDisclosureRef);
    expect(() => buildScaP08InlineOpeningAppendix({ store: artifacts, assignment: bound })).toThrow(
      /authorized refs differ/
    );
    // The untampered pair still projects exactly.
    const intact = assignment(run.identity.run_id, payloadRef, disclosureRef);
    expect(() =>
      buildScaP08InlineOpeningAppendix({ store: artifacts, assignment: intact })
    ).not.toThrow();
  });

  it("refuses an unknown or non-uniquely bound provider opening guard literal", () => {
    expect(isProviderOpeningGuardId("sca_p99_payload_disclosure_v1")).toBe(false);
    expect(() =>
      resolveProviderOpeningGuard({
        id: "sca_p99_payload_disclosure_v1",
        registration_name: "sca-p08-candidate",
        state_id: SCA_P08_ASSESSING_STATE,
        agent: "demetri",
        adapters: [SCA_P08_PROVIDER_OPENING_ADAPTER],
      })
    ).toThrow();
    expect(() =>
      resolveProviderOpeningGuard({
        id: SCA_P08_PROVIDER_OPENING_GUARD,
        registration_name: "sca-p08-candidate",
        state_id: SCA_P08_ASSESSING_STATE,
        agent: "someone-else",
        adapters: [SCA_P08_PROVIDER_OPENING_ADAPTER],
      })
    ).toThrow();
  });
});
