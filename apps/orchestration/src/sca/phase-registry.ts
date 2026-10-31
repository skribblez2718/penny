import {
  validateRegistrationContract,
  type PlaybookRegistration,
  type PlaybookRegistry,
} from "../playbooks/registry.js";
import { SCA_P02_PHASE_PLAYBOOK_NAME, SCA_P02_PHASE_REGISTRATION } from "./p02-playbook.js";
import { SCA_P03_PHASE_PLAYBOOK_NAME, SCA_P03_PHASE_REGISTRATION } from "./p03-playbook.js";

/**
 * Accepted target-phase registrations. This registry is deliberately separate from the
 * user-facing PLAYBOOK_REGISTRY: an entry here can be resolved only after the durable SCA phase
 * activation owner replays its current qualification and operator authority.
 */
export const SCA_PHASE_REGISTRY: PlaybookRegistry = new Map<string, PlaybookRegistration>([
  [SCA_P02_PHASE_PLAYBOOK_NAME, SCA_P02_PHASE_REGISTRATION],
  [SCA_P03_PHASE_PLAYBOOK_NAME, SCA_P03_PHASE_REGISTRATION],
]);

for (const [name, registration] of SCA_PHASE_REGISTRY) {
  if (registration.name !== name) throw new Error(`SCA phase registration '${name}' is misbound`);
  validateRegistrationContract(registration);
}

export function resolveScaPhaseRegistration(name: string): PlaybookRegistration | undefined {
  return SCA_PHASE_REGISTRY.get(name);
}
