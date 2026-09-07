import path from "node:path";

import {
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

export type SkillIngressRefusalCode =
  | "SKILL_NOT_REGISTERED"
  | "SKILL_ENTRYPOINT_MISMATCH"
  | "SKILL_PACKAGE_INVALID";

export type SkillIngressResolution =
  | {
      readonly ok: true;
      readonly registration: PlaybookRegistrationV1;
      readonly contract_sha256: string;
    }
  | {
      readonly ok: false;
      readonly code: SkillIngressRefusalCode;
      readonly message: string;
    };

function refusal(code: SkillIngressRefusalCode, message: string): SkillIngressResolution {
  return { ok: false, code, message };
}

/**
 * Resolve one user-facing skill against the sole executable registry.
 *
 * `disable-model-invocation` affects discovery visibility only. An unregistered disabled package
 * such as a development scaffold remains inspectable but cannot reach the engine through this
 * generic entrypoint.
 */
export function resolveSkillIngress(input: {
  readonly projectRoot: string;
  readonly skillsDir?: string;
  readonly discoveredSkills?: readonly SkillDiscovery[];
  readonly name: string;
  readonly registry?: PlaybookRegistryV1;
}): SkillIngressResolution {
  const skillsDir = input.skillsDir ?? path.join(input.projectRoot, ".pi", "skills");
  const discoveredSkills = input.discoveredSkills ?? discoverSkillsFromDirectory(skillsDir);
  const registry = input.registry ?? PLAYBOOK_REGISTRY;
  const registration = registry.get(input.name);
  if (registration === undefined) {
    return refusal("SKILL_NOT_REGISTERED", `skill '${input.name}' is not registered`);
  }
  try {
    validateRegistrationContract(registration);
  } catch (error) {
    return refusal(
      "SKILL_ENTRYPOINT_MISMATCH",
      error instanceof Error ? error.message : "skill registration is invalid"
    );
  }
  if (registration.ingress !== "skill") {
    return refusal(
      "SKILL_ENTRYPOINT_MISMATCH",
      `registration '${input.name}' uses '${registration.ingress}' ingress`
    );
  }
  const packageCheck = checkSkillPackage({
    skillsDir,
    name: input.name,
    discoveredSkills,
  });
  if (!packageCheck.ok) {
    return refusal("SKILL_PACKAGE_INVALID", packageCheck.reason);
  }
  return {
    ok: true,
    registration,
    contract_sha256: skillContractSha256(registration.contract),
  };
}
