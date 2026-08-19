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
 * ## Registration history — read this before adding an entry
 *
 * **Foundation stage (workstream 1): exactly one entry.** Research was the sole
 * registration, because research is the mandatory parity/canary oracle
 * (`agents-md-research` §1 outcome 5) and the Foundation PRD's binding constraint 1
 * forbade registering or activating a second skill during that stage. Multi-playbook
 * dispatch was proven with an injected test double, never a shipped registration.
 *
 * **Workstream 2 (post-G6): a second entry is authorized.** G6 passed by operator
 * decision 2026-08-18, which unblocks stateful KB work, and the KB playbook is the
 * second playbook the whole seam extraction existed to host. The Foundation-stage
 * "exactly one entry" rule ended with that stage; it is not a standing invariant.
 *
 * **Recorded defect (2026-08-19).** The KB entry was added at G8 while this docstring
 * still claimed "exactly one entry … never with a shipped registration", and
 * `assertSoleProductionRegistration()` was weakened to "research is present" in the
 * same change that would otherwise have failed — with its test edited to match. The
 * Foundation PRD §8 names that exact stop condition ("a parity test is edited in the
 * same change that makes it fail"). This block, `assertExpectedRegistrations()`, and
 * the accompanying test now state one truth instead of three.
 *
 * `assertExpectedRegistrations()` is the executable form of the *current* rule:
 * research must always be present, and only explicitly authorized names may ship.
 * An accidental or unauthorized registration fails closed.
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
 * Every playbook name authorized to ship, in sorted order.
 *
 * `research` — the parity/canary oracle, authorized since the Foundation stage.
 * `knowledge-base` — authorized by the G6 operator decision of 2026-08-18.
 *
 * Adding a name here is the explicit authorization step. It is deliberately a
 * separate edit from adding the registration itself.
 */
export const AUTHORIZED_PLAYBOOK_NAMES: readonly string[] = [
  "knowledge-base",
  SOLE_PRODUCTION_PLAYBOOK,
];

/**
 * Executable form of the current registration rule. Fails closed on both sides:
 * research must be present (it is the oracle every other gate leans on), and no
 * unauthorized name may ship (a registration is an authority grant, so an
 * accidental one is a hard error rather than a warning).
 */
export function assertExpectedRegistrations(
  registry: PlaybookRegistryV1 = PLAYBOOK_REGISTRY
): void {
  const names = registeredPlaybookNames(registry);
  if (!names.includes(SOLE_PRODUCTION_PLAYBOOK)) {
    throw new Error(`research playbook is missing from the registry; found [${names.join(", ")}]`);
  }
  const unauthorized = names.filter((n) => !AUTHORIZED_PLAYBOOK_NAMES.includes(n));
  if (unauthorized.length > 0) {
    throw new Error(
      `unauthorized playbook registration(s) [${unauthorized.join(", ")}]; ` +
        `authorized names are [${[...AUTHORIZED_PLAYBOOK_NAMES].join(", ")}]`
    );
  }
}
