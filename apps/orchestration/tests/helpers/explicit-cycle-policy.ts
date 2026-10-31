import type { PlaybookRegistration } from "../../dist/playbooks/registry.js";

/** Test-owned explicit policy for exhaustion scenarios; never a production default. */
export function explicitSealPolicy(
  registration: PlaybookRegistration,
  correctionLimit: number
): PlaybookRegistration {
  if (registration.seal_policy === undefined) throw new Error("seal policy is absent");
  return {
    ...registration,
    seal_policy: { ...registration.seal_policy, correction_limit: correctionLimit },
  };
}
