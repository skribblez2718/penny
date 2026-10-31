import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../dist/checkpointer.js";
import {
  validateChildProviderQualificationManifest,
  validateChildWorkflowCallRecord,
  validateInitialChildWorkflowDirective,
} from "../dist/child-workflows/contracts.js";
import {
  AUTHORIZED_PLAYBOOK_NAMES,
  bindGenericChildYamlAuthority,
  PLAYBOOK_REGISTRY,
  resolvePlaybook,
  runtimeRegistrationSha256,
  type PlaybookRegistration,
} from "../dist/playbooks/registry.js";
import { OrchestrationService } from "../dist/service.js";
import { initializePennyState } from "../dist/state/setup.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const temporaryRoots: string[] = [];

// Current pins include source-SUMMARY preservation, exact-fingerprint opt-ins, the closed
// UNVERIFIABLE variant and changed review prompts. Produce retains its stronger review-core
// policy; Knowledge Base is unchanged. These are not qualification or historical-state migration.
const CURRENT_BOUND_REGISTRATION_DIGESTS = {
  assess: "d11684e4d7ab2852f0e5c10e77c647d8df5b20b0bc85deff3ba43c97e9f80868",
  decide: "dc679ff08d0ee0ce0b9b37070f1041f20d8abf12b25915f8daeb5a87cc2128b9",
  define: "8c2034bb2fe39524a6a3c19a9b896e58dae553761c232afeb3476c5b61174545",
  diagnose: "49d5786bc474285ace7c1b4d7f6319b26a0431b9ea536a649eec4f3491791317",
  "knowledge-base": "3eac9690352d2894c13c1763873f141a21551b6c20154bccf5f24d159973315c",
  plan: "0379a875c84be0c5deb0a2844ec37940114daa60f95ae32ba19bcb40a33433e7",
  produce: "23e62d408a10a4eb6a3ee0b4e7f8f43ba46201c02f7cd71afa126f28979f6b8b",
  research: "93c94a2cedde719cb1a7158c843ea8cda975756b7f2c856d98d80d9db779be9a",
} as const;

const SOURCE_SUMMARY_PHASES = {
  assess: ["verifying_assessment"],
  decide: ["critiquing_decision", "verifying_decision"],
  define: ["critiquing_specification", "verifying_specification"],
  diagnose: ["verifying_diagnosis"],
  "knowledge-base": [],
  plan: ["critiquing_strategy", "verifying_strategy"],
  produce: [],
  research: ["critiquing_plan", "critiquing_report", "validating"],
} as const;

const WRITING_DOCUMENT_SOURCES = [
  {
    path: "docs/agents/writing/standard.md",
    sha256: "827e647cf29cb75d25fc3be5a63a6fe331896d6db051e91689c8dd569661b290",
  },
  {
    path: "docs/agents/writing/review.md",
    sha256: "ba52f6b665dda157fe7aa633bd74c3ec1dcdc2a9ba64415392776bf716c8d582",
  },
] as const;

const RESEARCH_DOCUMENT_SOURCE = {
  path: "docs/agents/writing/genres/research.md",
  sha256: "5f0591994dd344f7e8dbe2c1f6d385314bdf4778716279d52a9f8caa70483e67",
} as const;

const FUTURE_REGISTRATION_INVALIDATIONS = {
  assess: [
    "parent_policy",
    "provider_descriptor",
    "qualification_binding",
    "static_documentation_binding",
  ],
  decide: [
    "parent_policy",
    "provider_descriptor",
    "qualification_binding",
    "static_documentation_binding",
  ],
  define: [
    "parent_policy",
    "provider_descriptor",
    "qualification_binding",
    "static_documentation_binding",
  ],
  diagnose: [
    "parent_policy",
    "provider_descriptor",
    "qualification_binding",
    "static_documentation_binding",
  ],
  "knowledge-base": ["parent_policy", "static_documentation_binding"],
  plan: [
    "parent_policy",
    "provider_descriptor",
    "qualification_binding",
    "static_documentation_binding",
  ],
  produce: [
    "parent_policy",
    "provider_descriptor",
    "qualification_binding",
    "static_documentation_binding",
  ],
  research: [
    "parent_policy",
    "provider_descriptor",
    "qualification_binding",
    "static_documentation_binding",
  ],
} as const;

type BinaryGeneration = "old" | "new";
type RunGeneration = "legacy_unbound" | BinaryGeneration;
type RunBoundary = "active" | "paused" | "gated" | "chain_linked" | "terminal";
type RolloutPhase = "cutover_stop" | "old_drain" | "new_writer" | "rollback_new_drain";
type RolloutOperation =
  | "status"
  | "cancel"
  | "continue_existing"
  | "respond_gate"
  | "start_next_chain"
  | "read_terminal"
  | "start"
  | "rollback";
type RolloutDisposition =
  | "allow_read_only"
  | "allow_old_drain"
  | "allow_new_drain"
  | "allow_new_write"
  | "legacy_pause_exact"
  | "legacy_terminal_exact"
  | "refuse_starts_stopped"
  | "refuse_digest_mismatch"
  | "refuse_operation"
  | "refuse_until_old_drained"
  | "refuse_until_new_drained"
  | "refuse_state_preimage_changed"
  | "rollback_ready";

interface RolloutInput {
  readonly phase: RolloutPhase;
  readonly binary: BinaryGeneration;
  readonly run_generation?: RunGeneration;
  readonly boundary?: RunBoundary;
  readonly operation: RolloutOperation;
  readonly registration_digest_matches: boolean;
  readonly old_nonterminal_cohorts: number;
  readonly new_nonterminal_cohorts: number;
  readonly state_preimage_matches: boolean;
}

interface RolloutFixtureRow extends RolloutInput {
  readonly id: string;
  readonly expected: RolloutDisposition;
}

function rolloutDisposition(input: RolloutInput): RolloutDisposition {
  if (input.run_generation === "legacy_unbound") {
    if (input.boundary === "terminal") return "legacy_terminal_exact";
    return "legacy_pause_exact";
  }
  if (input.operation === "start") {
    if (input.phase !== "new_writer") return "refuse_starts_stopped";
    if (input.old_nonterminal_cohorts !== 0) return "refuse_until_old_drained";
    return "allow_new_write";
  }
  if (input.operation === "rollback") {
    if (input.new_nonterminal_cohorts !== 0) return "refuse_until_new_drained";
    if (!input.state_preimage_matches) return "refuse_state_preimage_changed";
    return "rollback_ready";
  }
  if (
    input.run_generation === undefined ||
    input.run_generation !== input.binary ||
    !input.registration_digest_matches
  ) {
    return "refuse_digest_mismatch";
  }
  if (input.operation === "status") return "allow_read_only";
  if (input.operation === "cancel") {
    return input.binary === "old" ? "allow_old_drain" : "allow_new_drain";
  }
  if (input.boundary === "terminal") {
    return input.operation === "read_terminal" ? "allow_read_only" : "refuse_operation";
  }
  if (input.operation === "start_next_chain") return "refuse_operation";
  if (input.operation === "respond_gate" && input.boundary !== "gated") {
    return "refuse_operation";
  }
  if (
    input.operation === "continue_existing" &&
    input.boundary !== "active" &&
    input.boundary !== "paused" &&
    input.boundary !== "chain_linked"
  ) {
    return "refuse_operation";
  }
  return input.binary === "old" ? "allow_old_drain" : "allow_new_drain";
}

const ROLLOUT_ROWS = [
  {
    id: "cutover-stops-old-digest-start",
    phase: "cutover_stop",
    binary: "old",
    operation: "start",
    registration_digest_matches: true,
    old_nonterminal_cohorts: 1,
    new_nonterminal_cohorts: 0,
    state_preimage_matches: true,
    expected: "refuse_starts_stopped",
  },
  {
    id: "old-active-drains-on-old-binary",
    phase: "old_drain",
    binary: "old",
    run_generation: "old",
    boundary: "active",
    operation: "continue_existing",
    registration_digest_matches: true,
    old_nonterminal_cohorts: 1,
    new_nonterminal_cohorts: 0,
    state_preimage_matches: true,
    expected: "allow_old_drain",
  },
  {
    id: "old-paused-drains-on-old-binary",
    phase: "old_drain",
    binary: "old",
    run_generation: "old",
    boundary: "paused",
    operation: "continue_existing",
    registration_digest_matches: true,
    old_nonterminal_cohorts: 1,
    new_nonterminal_cohorts: 0,
    state_preimage_matches: true,
    expected: "allow_old_drain",
  },
  {
    id: "old-gated-drains-on-old-binary",
    phase: "old_drain",
    binary: "old",
    run_generation: "old",
    boundary: "gated",
    operation: "respond_gate",
    registration_digest_matches: true,
    old_nonterminal_cohorts: 1,
    new_nonterminal_cohorts: 0,
    state_preimage_matches: true,
    expected: "allow_old_drain",
  },
  {
    id: "old-chain-current-step-drains-on-old-binary",
    phase: "old_drain",
    binary: "old",
    run_generation: "old",
    boundary: "chain_linked",
    operation: "continue_existing",
    registration_digest_matches: true,
    old_nonterminal_cohorts: 1,
    new_nonterminal_cohorts: 0,
    state_preimage_matches: true,
    expected: "allow_old_drain",
  },
  {
    id: "old-chain-next-step-is-a-new-start",
    phase: "old_drain",
    binary: "old",
    run_generation: "old",
    boundary: "chain_linked",
    operation: "start_next_chain",
    registration_digest_matches: true,
    old_nonterminal_cohorts: 1,
    new_nonterminal_cohorts: 0,
    state_preimage_matches: true,
    expected: "refuse_operation",
  },
  {
    id: "old-terminal-reader-is-exact-on-old-binary",
    phase: "old_drain",
    binary: "old",
    run_generation: "old",
    boundary: "terminal",
    operation: "read_terminal",
    registration_digest_matches: true,
    old_nonterminal_cohorts: 0,
    new_nonterminal_cohorts: 0,
    state_preimage_matches: true,
    expected: "allow_read_only",
  },
  {
    id: "old-active-refuses-new-binary-rebind",
    phase: "old_drain",
    binary: "new",
    run_generation: "old",
    boundary: "active",
    operation: "continue_existing",
    registration_digest_matches: false,
    old_nonterminal_cohorts: 1,
    new_nonterminal_cohorts: 0,
    state_preimage_matches: true,
    expected: "refuse_digest_mismatch",
  },
  {
    id: "old-terminal-refuses-new-binary-rebind",
    phase: "new_writer",
    binary: "new",
    run_generation: "old",
    boundary: "terminal",
    operation: "read_terminal",
    registration_digest_matches: false,
    old_nonterminal_cohorts: 0,
    new_nonterminal_cohorts: 0,
    state_preimage_matches: true,
    expected: "refuse_digest_mismatch",
  },
  {
    id: "new-writer-waits-for-old-drain",
    phase: "new_writer",
    binary: "new",
    operation: "start",
    registration_digest_matches: true,
    old_nonterminal_cohorts: 1,
    new_nonterminal_cohorts: 0,
    state_preimage_matches: true,
    expected: "refuse_until_old_drained",
  },
  {
    id: "new-writer-starts-after-old-drain",
    phase: "new_writer",
    binary: "new",
    operation: "start",
    registration_digest_matches: true,
    old_nonterminal_cohorts: 0,
    new_nonterminal_cohorts: 0,
    state_preimage_matches: true,
    expected: "allow_new_write",
  },
  {
    id: "new-active-continues-on-new-binary",
    phase: "new_writer",
    binary: "new",
    run_generation: "new",
    boundary: "active",
    operation: "continue_existing",
    registration_digest_matches: true,
    old_nonterminal_cohorts: 0,
    new_nonterminal_cohorts: 1,
    state_preimage_matches: true,
    expected: "allow_new_drain",
  },
  {
    id: "old-binary-refuses-new-run",
    phase: "new_writer",
    binary: "old",
    run_generation: "new",
    boundary: "active",
    operation: "status",
    registration_digest_matches: false,
    old_nonterminal_cohorts: 0,
    new_nonterminal_cohorts: 1,
    state_preimage_matches: true,
    expected: "refuse_digest_mismatch",
  },
  {
    id: "legacy-unbound-active-pauses-without-backfill",
    phase: "old_drain",
    binary: "old",
    run_generation: "legacy_unbound",
    boundary: "active",
    operation: "continue_existing",
    registration_digest_matches: false,
    old_nonterminal_cohorts: 1,
    new_nonterminal_cohorts: 0,
    state_preimage_matches: true,
    expected: "legacy_pause_exact",
  },
  {
    id: "legacy-unbound-terminal-replays-exactly",
    phase: "old_drain",
    binary: "old",
    run_generation: "legacy_unbound",
    boundary: "terminal",
    operation: "read_terminal",
    registration_digest_matches: false,
    old_nonterminal_cohorts: 0,
    new_nonterminal_cohorts: 0,
    state_preimage_matches: true,
    expected: "legacy_terminal_exact",
  },
  {
    id: "rollback-waits-for-new-drain",
    phase: "rollback_new_drain",
    binary: "new",
    operation: "rollback",
    registration_digest_matches: true,
    old_nonterminal_cohorts: 0,
    new_nonterminal_cohorts: 1,
    state_preimage_matches: true,
    expected: "refuse_until_new_drained",
  },
  {
    id: "rollback-refuses-newer-state-overwrite",
    phase: "rollback_new_drain",
    binary: "new",
    operation: "rollback",
    registration_digest_matches: true,
    old_nonterminal_cohorts: 0,
    new_nonterminal_cohorts: 0,
    state_preimage_matches: false,
    expected: "refuse_state_preimage_changed",
  },
  {
    id: "rollback-ready-after-drain-and-preimage-check",
    phase: "rollback_new_drain",
    binary: "new",
    operation: "rollback",
    registration_digest_matches: true,
    old_nonterminal_cohorts: 0,
    new_nonterminal_cohorts: 0,
    state_preimage_matches: true,
    expected: "rollback_ready",
  },
] as const satisfies readonly RolloutFixtureRow[];

interface QualificationDigestVector {
  readonly runtime_registration_sha256: string;
  readonly parent_contracts_sha256: string;
  readonly provider_descriptor_sha256: string;
  readonly validator_sha256: string;
  readonly guidance_sha256: string;
  readonly tool_contract_sha256: string;
  readonly non_time_policy_sha256: string;
  readonly progress_lease_policy_sha256: string;
  readonly fixture_set_sha256: string;
  readonly environment_manifest_sha256: string;
  readonly provider_profile_sha256: string;
}

type QualificationDigestField = keyof QualificationDigestVector;

const QUALIFICATION_DIGEST_FIELDS = [
  "runtime_registration_sha256",
  "parent_contracts_sha256",
  "provider_descriptor_sha256",
  "validator_sha256",
  "guidance_sha256",
  "tool_contract_sha256",
  "non_time_policy_sha256",
  "progress_lease_policy_sha256",
  "fixture_set_sha256",
  "environment_manifest_sha256",
  "provider_profile_sha256",
] as const satisfies readonly QualificationDigestField[];

function qualificationImpact(
  accepted: QualificationDigestVector,
  candidate: QualificationDigestVector
): "current" | "stale_non_discoverable" {
  const changed = QUALIFICATION_DIGEST_FIELDS.some((field) => accepted[field] !== candidate[field]);
  return changed ? "stale_non_discoverable" : "current";
}

function qualificationVector(seed: string): QualificationDigestVector {
  const digest = (index: number): string =>
    (index.toString(16) + seed).padEnd(64, seed).slice(0, 64);
  return {
    runtime_registration_sha256: digest(0),
    parent_contracts_sha256: digest(1),
    provider_descriptor_sha256: digest(2),
    validator_sha256: digest(3),
    guidance_sha256: digest(4),
    tool_contract_sha256: digest(5),
    non_time_policy_sha256: digest(6),
    progress_lease_policy_sha256: digest(7),
    fixture_set_sha256: digest(8),
    environment_manifest_sha256: digest(9),
    provider_profile_sha256: digest(10),
  };
}

function environment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), "penny-child-rollout-"));
  temporaryRoots.push(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PENNY_STATE_ROOT: path.join(root, "state"),
    PI_OBSERVABILITY_AUTO_START: "false",
    PI_OBSERVABILITY_ENABLED: "false",
  };
  initializePennyState(PROJECT_ROOT, { env });
  return env;
}

function assessmentStart(runId: string) {
  const request = {
    schema_version: 1 as const,
    assessment_purpose: "Assess one closed rollout fixture.",
    target: [{ statement: "The rollout fixture is closed." }],
    criteria: [
      { statement: "It preserves exact digest identity.", importance: "required" as const },
    ],
    supplied_evidence: [{ statement: "The fixture records the expected digest." }],
    hard_constraints: [{ statement: "Do not access providers or live state." }],
    non_goals: [{ statement: "Do not deploy or migrate." }],
    known_uncertainties: [],
  };
  const { assessment_purpose: goal, ...constraints } = request;
  return {
    schema_version: 2 as const,
    action: "start" as const,
    identity: {
      schema_version: 2 as const,
      run_id: runId,
      session_id: runId,
      playbook: "assess",
      engine_owner: "typescript" as const,
    },
    goal,
    constraints,
    project_root: PROJECT_ROOT,
    trust_profile: "hardened-untrusted" as const,
  };
}

function syntheticSuccessorRegistration(registration: PlaybookRegistration): PlaybookRegistration {
  const predicates = new Map(registration.completionReceiptPredicates);
  predicates.set("cw01_t3_synthetic_successor.v1", () => ({
    passed: false,
    evidence_refs: [],
  }));
  return { ...registration, completionReceiptPredicates: predicates };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("CW-01-T3 rollout and registration-digest freeze", () => {
  it("pins the current bound registrations and every known future invalidation class", () => {
    expect([...PLAYBOOK_REGISTRY.keys()]).toEqual([...AUTHORIZED_PLAYBOOK_NAMES]);
    const summaryPolicies = new Map(Object.entries(SOURCE_SUMMARY_PHASES));
    for (const [name, expectedDigest] of Object.entries(CURRENT_BOUND_REGISTRATION_DIGESTS)) {
      const expectedSummaryPhases = summaryPolicies.get(name);
      if (expectedSummaryPhases === undefined) throw new Error(`missing loop policy pin '${name}'`);
      const registration = resolvePlaybook(name);
      if (registration === undefined) throw new Error(`missing registration '${name}'`);
      const bound = bindGenericChildYamlAuthority(registration, PROJECT_ROOT);
      expect(runtimeRegistrationSha256(bound), name).toBe(expectedDigest);
      expect(bound.repair_progress_policy, name).toBe(
        name === "knowledge-base" ? undefined : "exact_fingerprint_v1"
      );
      expect(
        [...bound.worker.phases]
          .flatMap(([state, phase]) =>
            "routing_repair_policy" in phase ? [{ state, policy: phase.routing_repair_policy }] : []
          )
          .sort((left, right) => left.state.localeCompare(right.state)),
        name
      ).toEqual(
        expectedSummaryPhases.map((state) => ({
          state,
          policy: "preserve_source_summary_v1",
        }))
      );
      expect(FUTURE_REGISTRATION_INVALIDATIONS).toHaveProperty(name);
      const expectedDocumentation =
        name === "research"
          ? [...WRITING_DOCUMENT_SOURCES, RESEARCH_DOCUMENT_SOURCE]
          : [...WRITING_DOCUMENT_SOURCES];
      expect(bound.worker.documentation_sources, name).toEqual(expectedDocumentation);
    }
    expect(PLAYBOOK_REGISTRY.get("knowledge-base")?.generic_child).toBeUndefined();
    for (const name of [
      "assess",
      "decide",
      "define",
      "diagnose",
      "plan",
      "produce",
      "research",
    ] as const) {
      expect(PLAYBOOK_REGISTRY.get(name)?.generic_child?.provider.qualification).toEqual({
        gate_id: "gate_2_live_provider",
        status: "not_run",
        evidence: null,
      });
    }
  });

  it("binds scoped research-writing guidance without changing provider qualification", () => {
    const registration = resolvePlaybook("research");
    if (registration === undefined) throw new Error("missing research registration");
    const bound = bindGenericChildYamlAuthority(registration, PROJECT_ROOT);
    expect(bound.worker.documentation_sources).toEqual([
      ...WRITING_DOCUMENT_SOURCES,
      RESEARCH_DOCUMENT_SOURCE,
    ]);
    expect(runtimeRegistrationSha256(bound)).toBe(CURRENT_BOUND_REGISTRATION_DIGESTS.research);
    expect(bound.generic_child?.provider.qualification).toEqual({
      gate_id: "gate_2_live_provider",
      status: "not_run",
      evidence: null,
    });
  });

  it("executes stop, exact-old-drain, new-writer, and rollback-drain policy rows", () => {
    expect(ROLLOUT_ROWS).toHaveLength(18);
    for (const row of ROLLOUT_ROWS) {
      expect(rolloutDisposition(row), row.id).toBe(row.expected);
    }
    expect(
      ROLLOUT_ROWS.every(
        (row) => row.expected !== "allow_new_write" || row.old_nonterminal_cohorts === 0
      )
    ).toBe(true);
    expect(
      ROLLOUT_ROWS.every(
        (row) =>
          row.expected !== "rollback_ready" ||
          (row.new_nonterminal_cohorts === 0 && row.state_preimage_matches)
      )
    ).toBe(true);
  });

  it("makes every qualification-bound digest change stale and non-discoverable", () => {
    const accepted = qualificationVector("a");
    expect(qualificationImpact(accepted, accepted)).toBe("current");
    for (const field of QUALIFICATION_DIGEST_FIELDS) {
      const changed = { ...accepted, [field]: "b".repeat(64) };
      expect(qualificationImpact(accepted, changed), field).toBe("stale_non_discoverable");
    }

    const manifest = validateChildProviderQualificationManifest({
      schema_id: "penny.child-provider-qualification-manifest.v1",
      schema_version: 1,
      manifest_id: "qualification-manifest-candidate",
      provider_name: "assess",
      status: "candidate",
      code_revision: "8fa2344",
      bindings: {
        parent_contracts_sha256: accepted.parent_contracts_sha256,
        provider_descriptor_sha256: accepted.provider_descriptor_sha256,
        validator_sha256: accepted.validator_sha256,
        guidance_sha256: accepted.guidance_sha256,
        tool_contract_sha256: accepted.tool_contract_sha256,
        non_time_policy_sha256: accepted.non_time_policy_sha256,
        progress_lease_policy_sha256: accepted.progress_lease_policy_sha256,
        fixture_set_sha256: accepted.fixture_set_sha256,
        environment_manifest_sha256: accepted.environment_manifest_sha256,
        provider_profile_sha256: accepted.provider_profile_sha256,
      },
      evidence_refs: [],
      independent_verification_ref: null,
      operator_decision_ref: null,
      state_reason: null,
      recorded_at: "2026-09-15T00:00:00.000Z",
    });
    expect(manifest.status).toBe("candidate");
    expect(manifest.independent_verification_ref).toBeNull();
    expect(manifest.operator_decision_ref).toBeNull();
  });

  it("refuses active old-digest checkpoints and exactly replays historical terminals", () => {
    const env = environment();
    const current = resolvePlaybook("assess");
    if (current === undefined) throw new Error("assess registration is unavailable");
    const activeRequest = assessmentStart("run-cw01-t3-active-old-digest");
    const terminalRequest = assessmentStart("run-cw01-t3-terminal-old-digest");
    let historicalTerminal: ReturnType<OrchestrationService["handle"]>;
    {
      using oldBinary = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        playbookRegistration: current,
        enableChildWorkflows: false,
      });
      expect(oldBinary.handle(activeRequest).action).toBe("invoke_agent");
      expect(oldBinary.handle(terminalRequest).action).toBe("invoke_agent");
      historicalTerminal = oldBinary.handle({
        schema_version: 2,
        action: "cancel",
        identity: terminalRequest.identity,
        reason: "freeze a terminal old-digest cohort",
      });
      expect(historicalTerminal.action).toBe("cancelled");
    }

    const successor = syntheticSuccessorRegistration(current);
    const boundSuccessor = bindGenericChildYamlAuthority(successor, PROJECT_ROOT);
    expect(runtimeRegistrationSha256(boundSuccessor)).not.toBe(
      CURRENT_BOUND_REGISTRATION_DIGESTS.assess
    );
    using newBinary = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      playbookRegistration: successor,
      enableChildWorkflows: false,
    });
    const activeBefore = canonicalJson(
      newBinary.checkpointer.loadRun(activeRequest.identity).snapshot()
    );
    const terminalBefore = canonicalJson(
      newBinary.checkpointer.loadRun(terminalRequest.identity).snapshot()
    );
    for (const action of ["status", "recover", "cancel"] as const) {
      const active = newBinary.handle({
        schema_version: 2,
        action,
        identity: activeRequest.identity,
        ...(action === "cancel" ? { reason: "must refuse registration drift" } : {}),
      });
      expect(active).toMatchObject({
        action: "error",
        result: { code: "REGISTRATION_CONTRACT_MISMATCH", checkpoint_unchanged: true },
      });
      expect(
        newBinary.handle({
          schema_version: 2,
          action,
          identity: terminalRequest.identity,
          ...(action === "cancel" ? { reason: "must not rewrite history" } : {}),
        })
      ).toEqual(historicalTerminal);
      expect(canonicalJson(newBinary.checkpointer.loadRun(activeRequest.identity).snapshot())).toBe(
        activeBefore
      );
      expect(
        canonicalJson(newBinary.checkpointer.loadRun(terminalRequest.identity).snapshot())
      ).toBe(terminalBefore);
    }
  });

  it("keeps V4 directives and V3 call records outside current runtime readers", () => {
    expect(() => validateInitialChildWorkflowDirective({ schema_version: 4 })).toThrow();
    expect(() => validateChildWorkflowCallRecord({ schema_version: 3 })).toThrow();
  });

  it("leaves production registry membership, authority, and qualification unchanged", () => {
    const before = [...PLAYBOOK_REGISTRY.entries()].map(([name, registration]) => ({
      name,
      digest: runtimeRegistrationSha256(bindGenericChildYamlAuthority(registration, PROJECT_ROOT)),
      generic_child: registration.generic_child,
    }));
    for (const row of ROLLOUT_ROWS) rolloutDisposition(row);
    const after = [...PLAYBOOK_REGISTRY.entries()].map(([name, registration]) => ({
      name,
      digest: runtimeRegistrationSha256(bindGenericChildYamlAuthority(registration, PROJECT_ROOT)),
      generic_child: registration.generic_child,
    }));
    expect(after).toEqual(before);
  });
});
