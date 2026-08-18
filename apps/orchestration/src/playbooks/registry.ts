/**
 * W2 — Playbook registry (Foundation stage, workstream 1 of 3).
 *
 * `apps/orchestration/src/playbooks/registry.ts` is named as a required target by
 * `research/agents-md-research/IMPLEMENTATION_PLAN.md` §4.3. It is therefore an unmet
 * item of the agents-md plan, not only a universal-skills import.
 *
 * The registry maps a playbook name to its constructor. The engine constructs through it
 * and never imports a concrete playbook class, so adding a playbook is a registration
 * change rather than an engine change.
 *
 * ## Exactly one entry
 *
 * The Foundation stage registers **research and nothing else**. Research remains the sole
 * production skill and the mandatory parity/canary oracle (`agents-md-research` §1
 * outcome 5), and the M7 line forbids activating a second skill. Multi-playbook dispatch
 * is proven in tests with an injected double — never with a shipped registration.
 *
 * `assertSoleProductionRegistration()` makes that invariant executable rather than
 * aspirational.
 */

import { SkillContractSchema, validateContract, type SkillContract } from "../contracts.js";
import type { ArtifactRevisionLookup } from "../artifact-store.js";
import type { PlaybookV1 } from "./playbook.js";
import { RESEARCH_SKILL_CONTRACT, ResearchPlaybook } from "./research.js";

export interface PlaybookConstructionOptionsV1 {
  readonly artifactRevisions?: ArtifactRevisionLookup;
}

export interface PlaybookRegistrationV1 {
  readonly name: string;
  /** W3: the skill's declared contract. Validated at dispatch. */
  readonly contract: SkillContract;
  construct(options: PlaybookConstructionOptionsV1): PlaybookV1;
}

export type PlaybookRegistryV1 = ReadonlyMap<string, PlaybookRegistrationV1>;

/** The name of the sole production playbook for the Foundation stage. */
export const SOLE_PRODUCTION_PLAYBOOK = "research";

const RESEARCH_REGISTRATION: PlaybookRegistrationV1 = {
  name: SOLE_PRODUCTION_PLAYBOOK,
  contract: RESEARCH_SKILL_CONTRACT,
  construct: (options) => new ResearchPlaybook(options.artifactRevisions),
};

/**
 * The shipped registry. One entry, deliberately.
 *
 * Adding an entry here activates a skill and crosses the M7 line. It requires explicit
 * approval, not a code review.
 */
export const PLAYBOOK_REGISTRY: PlaybookRegistryV1 = new Map([
  [RESEARCH_REGISTRATION.name, RESEARCH_REGISTRATION],
]);

/** Registered names, sorted, for diagnostics and tests. */
export function registeredPlaybookNames(
  registry: PlaybookRegistryV1 = PLAYBOOK_REGISTRY
): string[] {
  return [...registry.keys()].sort();
}

export function isRegisteredPlaybook(
  name: string,
  registry: PlaybookRegistryV1 = PLAYBOOK_REGISTRY
): boolean {
  return registry.has(name);
}

/**
 * Resolve a registration, or `undefined` when the name is unregistered.
 *
 * Returning `undefined` rather than throwing keeps the caller in control of the refusal
 * shape: `engine.recover()` must continue to answer with the exact `PLAYBOOK_UNAVAILABLE`
 * directive it produced before this registry existed.
 */
export function resolvePlaybook(
  name: string,
  registry: PlaybookRegistryV1 = PLAYBOOK_REGISTRY
): PlaybookRegistrationV1 | undefined {
  return registry.get(name);
}

/**
 * W3 — validate a registration's contract at dispatch.
 *
 * Fails closed: a registration whose contract is missing a required field, carries an
 * unknown key, or declares a name that disagrees with its registry key cannot be
 * constructed. The contract is authority metadata, so an invalid one is a hard error
 * rather than a warning.
 */
export function validateRegistrationContract(registration: PlaybookRegistrationV1): SkillContract {
  const contract = validateContract(
    SkillContractSchema,
    registration.contract,
    `skill contract for playbook '${registration.name}'`
  );
  if (contract.name !== registration.name) {
    throw new Error(
      `skill contract name '${contract.name}' does not match registration '${registration.name}'`
    );
  }
  return contract;
}

/**
 * Executable form of the Foundation-stage constraint that research is the only
 * production skill. Throws when the shipped registry gains a second entry.
 */
export function assertSoleProductionRegistration(
  registry: PlaybookRegistryV1 = PLAYBOOK_REGISTRY
): void {
  const names = registeredPlaybookNames(registry);
  if (names.length !== 1 || names[0] !== SOLE_PRODUCTION_PLAYBOOK) {
    throw new Error(
      `Foundation stage registers exactly one playbook ('${SOLE_PRODUCTION_PLAYBOOK}'); found [${names.join(", ")}]. ` +
        `Activating a second skill crosses the M7 line and requires explicit approval.`
    );
  }
}
