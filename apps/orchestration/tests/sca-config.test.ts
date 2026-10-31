import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ContractValidationError } from "../dist/contracts.js";
import {
  scaPhaseRoleMapSha256,
  scaPolicySha256,
  scaProfileSha256,
  scaTargetSha256,
  validateScaConfigBundle,
  validateScaPhaseRoleMap,
  validateScaPolicy,
  validateScaProfile,
  validateScaTarget,
  type ScaPhaseRoleMapV1,
  type ScaPolicyV1,
  type ScaProfileV1,
  type ScaTargetV1,
} from "../dist/sca/config.js";
import {
  SCA_MODEL_OVERRIDE,
  scaModelOverride,
  scaModelPolicySha256,
  validateScaModelPolicy,
  validateScaResolvedModel,
} from "../dist/sca/model-policy.js";
import { requireValue } from "./helpers/narrowing.js";

const FIXTURE_ROOT = new URL("./fixtures/sca/", import.meta.url);

function fixture(name: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(new URL(name, FIXTURE_ROOT), "utf8"));
  return parsed;
}

function canonicalFixtures(): {
  readonly phaseRoleMap: ScaPhaseRoleMapV1;
  readonly profile: ScaProfileV1;
  readonly policy: ScaPolicyV1;
  readonly target: ScaTargetV1;
} {
  return {
    phaseRoleMap: validateScaPhaseRoleMap(fixture("phase-role-map.json")),
    profile: validateScaProfile(fixture("profile.json")),
    policy: validateScaPolicy(fixture("policy.json")),
    target: validateScaTarget(fixture("target.json")),
  };
}

function schemaIssues(validate: () => unknown): readonly string[] {
  try {
    validate();
  } catch (error) {
    if (error instanceof ContractValidationError) return error.issues;
    throw error;
  }
  throw new Error("expected malformed SCA input to fail schema validation");
}

function profileWithFirstRootRef(profile: ScaProfileV1, ref: string): unknown {
  const root = requireValue(profile.roots[0], "first SCA profile root");
  return {
    ...profile,
    roots: [{ ...root, project_relative_ref: ref }, ...profile.roots.slice(1)],
  };
}

function profileWithFirstCapabilityStatus(profile: ScaProfileV1, status: string): unknown {
  const capability = requireValue(
    profile.external_capabilities[0],
    "first SCA external capability"
  );
  return {
    ...profile,
    external_capabilities: [{ ...capability, status }, ...profile.external_capabilities.slice(1)],
  };
}

function profileWithModelProviderId(profile: ScaProfileV1, capabilityId: string): unknown {
  return {
    ...profile,
    external_capabilities: profile.external_capabilities.map((capability) =>
      capability.capability_class === "model_provider"
        ? { ...capability, capability_id: capabilityId }
        : capability
    ),
  };
}

describe("S-00-T2 SCA configuration boundary", () => {
  it("accepts the canonical generic synthetic fixtures as one closed bundle", () => {
    const values = canonicalFixtures();
    const bundle = validateScaConfigBundle(values);

    expect(bundle.phaseRoleMap.phases).toHaveLength(16);
    expect(bundle.phaseRoleMap.phases.filter((phase) => phase.child_route !== null)).toEqual([
      {
        phase_id: "explore_evidence_gap",
        agent: "echo",
        class: "production",
        child_route: { workflow: "research", max_calls: 1 },
      },
      {
        phase_id: "select_next_action",
        agent: "demetri",
        class: "production",
        child_route: { workflow: "decide", max_calls: 1 },
      },
      {
        phase_id: "design_verification",
        agent: "piper",
        class: "production",
        child_route: { workflow: "plan", max_calls: 1 },
      },
    ]);
    expect(bundle.target.target_id).toBe("synthetic-public-target-v1");
    expect(bundle.target.target_execution).toBe("disabled");
    expect(
      bundle.profile.external_capabilities.every(
        (capability) =>
          capability.status === "qualification_required" || capability.status === "disabled"
      )
    ).toBe(true);
  });

  it("accepts a second bounded caller-supplied profile, policy, and public target identity", () => {
    const values = canonicalFixtures();
    const policy = validateScaPolicy({
      ...values.policy,
      policy_id: "caller-default-deny-policy-v2",
    });
    const target = validateScaTarget({
      ...values.target,
      target_id: "caller-public-target-v2",
      source_visibility: "public",
    });
    const profile = validateScaProfile({
      ...values.profile,
      profile_id: "caller-profile-v2",
      bindings: {
        ...values.profile.bindings,
        policy: {
          ...values.profile.bindings.policy,
          sha256: scaPolicySha256(policy),
        },
        target: {
          ...values.profile.bindings.target,
          sha256: scaTargetSha256(target),
        },
      },
    });

    const bundle = validateScaConfigBundle({
      phaseRoleMap: values.phaseRoleMap,
      profile,
      policy,
      target,
    });

    expect(bundle.profile.profile_id).toBe("caller-profile-v2");
    expect(bundle.policy.policy_id).toBe("caller-default-deny-policy-v2");
    expect(bundle.target).toMatchObject({
      target_id: "caller-public-target-v2",
      source_visibility: "public",
    });
    expect(
      schemaIssues(() => validateScaProfile({ ...values.profile, profile_id: "x".repeat(129) }))
    ).toContain("/profile_id: maxLength constraint failed");
  });

  it("produces stable canonical SHA-256 values for every accepted fixture", () => {
    const values = canonicalFixtures();

    expect(scaPhaseRoleMapSha256(values.phaseRoleMap)).toBe(
      "b27de9d3106dd69bdf8a8bb191394eb0d8a872d89719d9179e76ab4970f88c2a"
    );
    expect(scaProfileSha256(values.profile)).toBe(
      "8f5b6c721afb1f96128d0f58468cfdf41e9851b1384d0548b9fc4481e5ebf958"
    );
    expect(scaPolicySha256(values.policy)).toBe(
      "5638449989b76b8715370637251f3c6255281ac229cae75d58671b0d806c091d"
    );
    expect(scaTargetSha256(values.target)).toBe(
      "2b54f0d795a53ad2c611f201705d269a13810034db2741f47bcb0682b15dac2a"
    );
    expect(scaModelPolicySha256(values.profile.model_policy)).toBe(
      "20a2dbc216fea8c2f8149c45d1f40f230a46c02adfaf1b3bbe1ab7bebf3a188c"
    );
    expect(
      scaPhaseRoleMapSha256({
        phases: values.phaseRoleMap.phases,
        schema_version: values.phaseRoleMap.schema_version,
        schema_id: values.phaseRoleMap.schema_id,
      })
    ).toBe(scaPhaseRoleMapSha256(values.phaseRoleMap));
  });

  it("normalizes set-like roots and capabilities before semantic hashing", () => {
    const { profile } = canonicalFixtures();
    const reordered = {
      ...profile,
      roots: [...profile.roots].reverse(),
      external_capabilities: [...profile.external_capabilities].reverse(),
    };

    expect(scaProfileSha256(reordered)).toBe(scaProfileSha256(profile));
    expect(validateScaProfile(reordered)).toEqual(profile);
  });

  it("rejects missing and unknown fields at top-level and nested boundaries", () => {
    const values = canonicalFixtures();
    const { roots: _roots, ...missingRoots } = values.profile;

    expect(() => validateScaProfile(missingRoots)).toThrow(/roots/u);
    expect(() => validateScaProfile({ ...values.profile, unknown: true })).toThrow(
      /additional properties/u
    );
    expect(() =>
      validateScaPolicy({
        ...values.policy,
        network: { ...values.policy.network, unknown: "deny" },
      })
    ).toThrow(/additional properties/u);
  });

  it("rejects traversal, absolute, encoded, and non-canonical project refs", () => {
    const { profile, target } = canonicalFixtures();

    for (const ref of [
      "sca-boundary/../escape",
      "/absolute/source",
      "C:/absolute/source",
      "sca-boundary/%2e%2e/escape",
      "sca-boundary\\source",
    ]) {
      expect(() => validateScaProfile(profileWithFirstRootRef(profile, ref))).toThrow(
        /project-relative|path segment/u
      );
    }
    expect(() =>
      validateScaTarget({ ...target, target_policy_ref: "/operator/policy.json" })
    ).toThrow(/project-relative/u);
  });

  it("rejects overlapping roots even when every individual ref is relative", () => {
    const { profile } = canonicalFixtures();
    const first = requireValue(profile.roots[0], "first SCA profile root");
    const second = requireValue(profile.roots[1], "second SCA profile root");

    expect(() =>
      validateScaProfile({
        ...profile,
        roots: [
          first,
          { ...second, project_relative_ref: `${first.project_relative_ref}/nested` },
          ...profile.roots.slice(2),
        ],
      })
    ).toThrow(/must not overlap/u);
  });

  it("rejects duplicate phases and any noncanonical phase-to-agent assignment", () => {
    const { phaseRoleMap } = canonicalFixtures();
    const first = requireValue(phaseRoleMap.phases[0], "first SCA phase");

    expect(() =>
      validateScaPhaseRoleMap({
        ...phaseRoleMap,
        phases: [first, first, ...phaseRoleMap.phases.slice(2)],
      })
    ).toThrow(/unique/u);
    expect(() =>
      validateScaPhaseRoleMap({
        ...phaseRoleMap,
        phases: [{ ...first, agent: "vera" }, ...phaseRoleMap.phases.slice(1)],
      })
    ).toThrow(/integrate_security_model/u);
  });

  it("rejects wrong model identities and accepts only the existing exact override shape", () => {
    const { profile } = canonicalFixtures();
    const modelPolicy = profile.model_policy;
    const alias = requireValue(modelPolicy.aliases[0], "SCA model alias");

    expect(scaModelOverride(modelPolicy)).toBe(SCA_MODEL_OVERRIDE);
    expect(
      validateScaResolvedModel(modelPolicy, {
        provider: "ollama",
        model: "deepseek-v4.1-flash:cloud",
      })
    ).toEqual({ provider: "ollama", model: "deepseek-v4.1-flash:cloud" });
    expect(
      schemaIssues(() =>
        validateScaModelPolicy({
          ...modelPolicy,
          aliases: [
            {
              ...alias,
              resolved: { provider: "ollama", model: "different-model" },
            },
          ],
        })
      )
    ).toContain("/aliases/resolved/model: const constraint failed");
    expect(() =>
      validateScaResolvedModel(modelPolicy, { provider: "other", model: alias.resolved.model })
    ).toThrow(/resolved model/u);
  });

  it("rejects fallback, per-agent override, and process-global override attempts", () => {
    const { profile } = canonicalFixtures();
    const modelPolicy = profile.model_policy;

    for (const candidate of [
      { ...modelPolicy, fallback: "default" },
      { ...modelPolicy, per_agent_overrides: [{ agent: "vera", model: "other" }] },
      { ...modelPolicy, process_global_override: true },
    ]) {
      expect(() => validateScaModelPolicy(candidate)).toThrow();
    }
  });

  it("rejects unsafe or broadened external destinations", () => {
    const { policy } = canonicalFixtures();

    expect(
      schemaIssues(() =>
        validateScaPolicy({
          ...policy,
          destination: {
            ...policy.destination,
            osv_api: {
              ...policy.destination.osv_api,
              origin: "http://169.254.169.254/latest/meta-data",
            },
          },
        })
      )
    ).toContain("/destination/osv_api/origin: const constraint failed");
    expect(
      schemaIssues(() =>
        validateScaPolicy({
          ...policy,
          destination: {
            ...policy.destination,
            research_web: {
              ...policy.destination.research_web,
              status: "enabled",
              allowed_origins: ["https://example.invalid"],
            },
          },
        })
      )
    ).toContain("/destination/research_web/status: const constraint failed");
  });

  it("rejects enabled external capabilities without exact qualified runtime bindings", () => {
    const { profile } = canonicalFixtures();

    expect(() => validateScaProfile(profileWithFirstCapabilityStatus(profile, "enabled"))).toThrow(
      /constant|anyOf/u
    );
  });

  it("rejects oversized refs and quota or numeric range violations", () => {
    const { profile } = canonicalFixtures();

    expect(
      schemaIssues(() =>
        validateScaProfile(profileWithFirstRootRef(profile, `sca-boundary/${"x".repeat(513)}`))
      )
    ).toContain("/roots/project_relative_ref: maxLength constraint failed");
    expect(
      schemaIssues(() =>
        validateScaProfile({
          ...profile,
          source_quotas: { ...profile.source_quotas, files: 100_001 },
        })
      )
    ).toContain("/source_quotas/files: maximum constraint failed");
    expect(
      schemaIssues(() =>
        validateScaProfile({
          ...profile,
          jobs: {
            ...profile.jobs,
            cpg_query: { ...profile.jobs.cpg_query, attempts: 0 },
          },
        })
      )
    ).toContain("/jobs/cpg_query/attempts: minimum constraint failed");
  });

  it("rejects target snapshot substitution and unsafe target refs", () => {
    const { target } = canonicalFixtures();

    expect(() => validateScaTarget({ ...target, snapshot_sha256: "f".repeat(64) })).toThrow(
      /snapshot ref and digest/u
    );
    expect(() =>
      validateScaTarget({ ...target, source_root_ref: "sca-boundary/../outside" })
    ).toThrow(/path segment/u);
  });

  it("rejects noncanonical snapshot and manifest artifact identities or content schemas", () => {
    const { target } = canonicalFixtures();
    const candidates: readonly unknown[] = [
      {
        ...target,
        snapshot_ref: { ...target.snapshot_ref, artifact_id: `art_${"f".repeat(64)}` },
      },
      {
        ...target,
        snapshot_ref: {
          ...target.snapshot_ref,
          store_ref: `artifact://sha256/${"f".repeat(64)}`,
        },
      },
      {
        ...target,
        snapshot_manifest_ref: {
          ...target.snapshot_manifest_ref,
          artifact_id: `art_${"f".repeat(64)}`,
        },
      },
      {
        ...target,
        snapshot_manifest_ref: {
          ...target.snapshot_manifest_ref,
          store_ref: `artifact://sha256/${"f".repeat(64)}`,
        },
      },
      {
        ...target,
        snapshot_ref: {
          ...target.snapshot_ref,
          content_schema: {
            schema_id: "penny.sca-other-snapshot.v1",
            schema_version: 1,
          },
        },
      },
      {
        ...target,
        snapshot_manifest_ref: {
          ...target.snapshot_manifest_ref,
          content_schema: {
            schema_id: "penny.sca-source-manifest.v1",
            schema_version: 2,
          },
        },
      },
    ];

    for (const candidate of candidates) {
      expect(() => validateScaTarget(candidate)).toThrow(
        /canonical identity|content_digest|content_schema/u
      );
    }
  });

  it("rejects every all-zero config binding and target digest placeholder", () => {
    const { profile, target } = canonicalFixtures();
    const zero = "0".repeat(64);
    const profileCandidates: readonly unknown[] = [
      { ...profile, model_policy_sha256: zero },
      {
        ...profile,
        bindings: {
          ...profile.bindings,
          phase_role_map: { ...profile.bindings.phase_role_map, sha256: zero },
        },
      },
      {
        ...profile,
        bindings: {
          ...profile.bindings,
          policy: { ...profile.bindings.policy, sha256: zero },
        },
      },
      {
        ...profile,
        bindings: {
          ...profile.bindings,
          target: { ...profile.bindings.target, sha256: zero },
        },
      },
    ];
    const targetCandidates: readonly unknown[] = [
      { ...target, snapshot_sha256: zero },
      {
        ...target,
        snapshot_ref: {
          ...target.snapshot_ref,
          content_digest: zero,
          store_ref: `artifact://sha256/${zero}`,
        },
      },
      { ...target, snapshot_manifest_sha256: zero },
      {
        ...target,
        snapshot_manifest_ref: {
          ...target.snapshot_manifest_ref,
          content_digest: zero,
          store_ref: `artifact://sha256/${zero}`,
        },
      },
      { ...target, target_policy_sha256: zero },
    ];

    for (const candidate of profileCandidates) {
      expect(() => validateScaProfile(candidate)).toThrow(/all-zero placeholder/u);
    }
    for (const candidate of targetCandidates) {
      expect(() => validateScaTarget(candidate)).toThrow(/all-zero placeholder/u);
    }
  });

  it("rejects model-provider capability drift across profile, model policy, and policy", () => {
    const values = canonicalFixtures();

    expect(() =>
      validateScaProfile(profileWithModelProviderId(values.profile, "caller.other-provider.v1"))
    ).toThrow(/embedded model policy/u);

    const policy = validateScaPolicy({
      ...values.policy,
      destination: {
        ...values.policy.destination,
        cloud_model: {
          ...values.policy.destination.cloud_model,
          status: "disabled",
        },
      },
    });
    const profile = validateScaProfile({
      ...values.profile,
      bindings: {
        ...values.profile.bindings,
        policy: {
          ...values.profile.bindings.policy,
          sha256: scaPolicySha256(policy),
        },
      },
    });

    expect(() => validateScaConfigBundle({ ...values, profile, policy })).toThrow(
      /default-deny policy/u
    );
  });

  it("rejects cross-fixture digest drift", () => {
    const values = canonicalFixtures();

    expect(() =>
      validateScaConfigBundle({
        ...values,
        profile: {
          ...values.profile,
          bindings: {
            ...values.profile.bindings,
            target: { ...values.profile.bindings.target, sha256: "f".repeat(64) },
          },
        },
      })
    ).toThrow(/target binding digest/u);
  });
});
