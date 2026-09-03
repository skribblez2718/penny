import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  CANDIDATE_PLAYBOOK_REGISTRY,
  PLAYBOOK_REGISTRY,
  skillContractSha256,
  validateRegistrationContract,
  type PlaybookRegistrationV1,
  type PlaybookRegistryV1,
} from "@penny/orchestration/source";

import {
  checkSkillPackage,
  discoverSkillsFromDirectory,
  type SkillDiscovery,
} from "./skill-discovery.js";

export const CANDIDATE_ENABLEMENT_RELATIVE_PATH = ".pi/candidate-enablement.json";

export type SkillIngressRefusalCode =
  | "SKILL_NOT_REGISTERED"
  | "SKILL_ENTRYPOINT_MISMATCH"
  | "CANDIDATE_DISABLED"
  | "CANDIDATE_CONFIG_INVALID"
  | "CANDIDATE_CONTRACT_STALE"
  | "CANDIDATE_PACKAGE_INVALID";

export type SkillIngressResolution =
  | {
      readonly ok: true;
      readonly registration: PlaybookRegistrationV1;
      readonly release_status: "production" | "candidate";
      readonly contract_sha256: string;
    }
  | {
      readonly ok: false;
      readonly code: SkillIngressRefusalCode;
      readonly message: string;
    };

interface EnabledCandidateV1 {
  readonly name: string;
  readonly contract_sha256: string;
}

interface CandidateEnablementV1 {
  readonly schema_version: 1;
  readonly enabled_candidates: readonly EnabledCandidateV1[];
}

type CandidateConfigRead =
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly reason: string }
  | { readonly status: "valid"; readonly config: CandidateEnablementV1 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function parseCandidateEnablement(value: unknown): CandidateEnablementV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["enabled_candidates", "schema_version"]) ||
    value.schema_version !== 1 ||
    !Array.isArray(value.enabled_candidates) ||
    value.enabled_candidates.length > 128
  ) {
    throw new Error("candidate enablement document does not match schema version 1");
  }
  const enabled: EnabledCandidateV1[] = [];
  const names = new Set<string>();
  for (const item of value.enabled_candidates) {
    if (
      !isRecord(item) ||
      !exactKeys(item, ["contract_sha256", "name"]) ||
      typeof item.name !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(item.name) ||
      typeof item.contract_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.contract_sha256) ||
      names.has(item.name)
    ) {
      throw new Error("candidate enablement entry is malformed or duplicated");
    }
    names.add(item.name);
    enabled.push({ name: item.name, contract_sha256: item.contract_sha256 });
  }
  return { schema_version: 1, enabled_candidates: enabled };
}

export function readCandidateEnablement(projectRoot: string): CandidateConfigRead {
  const configPath = path.join(projectRoot, CANDIDATE_ENABLEMENT_RELATIVE_PATH);
  if (!existsSync(configPath)) return { status: "missing" };
  try {
    const stats = lstatSync(configPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return { status: "invalid", reason: "candidate config is not a regular no-follow file" };
    }
    const bytes = readFileSync(configPath);
    if (bytes.length === 0 || bytes.length > 65_536) {
      return { status: "invalid", reason: "candidate config byte length is invalid" };
    }
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    return { status: "valid", config: parseCandidateEnablement(parsed) };
  } catch (error) {
    return {
      status: "invalid",
      reason: error instanceof Error ? error.message : "candidate config is invalid",
    };
  }
}

function refusal(code: SkillIngressRefusalCode, message: string): SkillIngressResolution {
  return { ok: false, code, message };
}

/** Resolve one user-facing skill without merging production and candidate namespaces. */
export function resolveSkillIngress(input: {
  readonly projectRoot: string;
  readonly skillsDir?: string;
  readonly discoveredSkills?: readonly SkillDiscovery[];
  readonly name: string;
  readonly productionRegistry?: PlaybookRegistryV1;
  readonly candidateRegistry?: PlaybookRegistryV1;
}): SkillIngressResolution {
  const skillsDir = input.skillsDir ?? path.join(input.projectRoot, ".pi", "skills");
  const discoveredSkills = input.discoveredSkills ?? discoverSkillsFromDirectory(skillsDir);
  const productionRegistry = input.productionRegistry ?? PLAYBOOK_REGISTRY;
  const candidateRegistry = input.candidateRegistry ?? CANDIDATE_PLAYBOOK_REGISTRY;
  const production = productionRegistry.get(input.name);
  if (production !== undefined) {
    if (candidateRegistry.has(input.name)) {
      return refusal(
        "SKILL_ENTRYPOINT_MISMATCH",
        `registration '${input.name}' overlaps production and candidate namespaces`
      );
    }
    try {
      validateRegistrationContract(production, "production");
    } catch (error) {
      return refusal(
        "SKILL_ENTRYPOINT_MISMATCH",
        error instanceof Error ? error.message : "production registration is invalid"
      );
    }
    if (production.ingress !== "skill") {
      return refusal(
        "SKILL_ENTRYPOINT_MISMATCH",
        `registration '${input.name}' uses '${production.ingress}' ingress`
      );
    }
    const packageCheck = checkSkillPackage({
      skillsDir,
      name: input.name,
      expectedReleaseStatus: "production",
      discoveredSkills,
    });
    if (!packageCheck.ok) {
      return refusal("SKILL_ENTRYPOINT_MISMATCH", packageCheck.reason);
    }
    return {
      ok: true,
      registration: production,
      release_status: "production",
      contract_sha256: skillContractSha256(production.contract),
    };
  }

  const candidate = candidateRegistry.get(input.name);
  if (candidate === undefined) {
    return refusal("SKILL_NOT_REGISTERED", `skill '${input.name}' is not registered`);
  }
  if (candidate.ingress !== "skill") {
    return refusal(
      "SKILL_ENTRYPOINT_MISMATCH",
      `candidate '${input.name}' does not use skill ingress`
    );
  }
  try {
    validateRegistrationContract(candidate, "candidate");
  } catch (error) {
    return refusal(
      "CANDIDATE_PACKAGE_INVALID",
      error instanceof Error ? error.message : "candidate registration is invalid"
    );
  }

  const config = readCandidateEnablement(input.projectRoot);
  if (config.status === "missing") {
    return refusal("CANDIDATE_DISABLED", `candidate '${input.name}' is not enabled`);
  }
  if (config.status === "invalid") {
    return refusal("CANDIDATE_CONFIG_INVALID", config.reason);
  }
  if (config.config.enabled_candidates.some((enabled) => !candidateRegistry.has(enabled.name))) {
    return refusal("CANDIDATE_CONFIG_INVALID", "candidate config names an unknown candidate");
  }
  const enabled = config.config.enabled_candidates.find((item) => item.name === input.name);
  if (enabled === undefined) {
    return refusal("CANDIDATE_DISABLED", `candidate '${input.name}' is not enabled`);
  }
  const digest = skillContractSha256(candidate.contract);
  if (enabled.contract_sha256 !== digest) {
    return refusal(
      "CANDIDATE_CONTRACT_STALE",
      `candidate '${input.name}' contract digest does not match static enablement`
    );
  }
  const packageCheck = checkSkillPackage({
    skillsDir,
    name: input.name,
    expectedReleaseStatus: "candidate",
    discoveredSkills,
  });
  if (!packageCheck.ok) {
    return refusal("CANDIDATE_PACKAGE_INVALID", packageCheck.reason);
  }
  return {
    ok: true,
    registration: candidate,
    release_status: "candidate",
    contract_sha256: digest,
  };
}
