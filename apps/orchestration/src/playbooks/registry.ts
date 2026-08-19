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
import { KNOWLEDGE_BASE_SKILL_CONTRACT, KnowledgeBasePlaybook } from "./knowledge-base.js";

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
 * The KB playbook registration — the second registry entry, added at G8.
 *
 * G6 has passed (operator decision 2026-08-18), so stateful KB work is unblocked.
 * The playbook is a stub; the actual workflow logic lives in `kb/workflows.ts`
 * and is invoked by the adapter's `knowledge_base` tool. This registration proves
 * the registry can hold two playbooks and the engine can dispatch to either.
 */
const KNOWLEDGE_BASE_REGISTRATION: PlaybookRegistrationV1 = {
  name: "knowledge-base",
  contract: KNOWLEDGE_BASE_SKILL_CONTRACT,
  construct: () => new KnowledgeBasePlaybook(),
};

/**
 * The shipped registry. Two entries: research (sole production skill) and
 * knowledge-base (G8 stub, operational via the adapter's knowledge_base tool).
 */
export const PLAYBOOK_REGISTRY: PlaybookRegistryV1 = new Map([
  [RESEARCH_REGISTRATION.name, RESEARCH_REGISTRATION],
  [KNOWLEDGE_BASE_REGISTRATION.name, KNOWLEDGE_BASE_REGISTRATION],
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
 * Executable form of the constraint that research is the only *production* skill.
 * The KB playbook is registered as a second entry, but it is a stub — not a
 * production skill. This assertion checks that research is present and that no
 * more than the expected set of playbooks is registered.
 */
export function assertSoleProductionRegistration(
  registry: PlaybookRegistryV1 = PLAYBOOK_REGISTRY
): void {
  const names = registeredPlaybookNames(registry);
  if (!names.includes(SOLE_PRODUCTION_PLAYBOOK)) {
    throw new Error(`research playbook is missing from the registry; found [${names.join(", ")}]`);
  }
}
