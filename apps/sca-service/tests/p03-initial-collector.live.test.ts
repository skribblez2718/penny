import { expect, it } from "vitest";
import { OrchestrationService } from "../../orchestration/dist/service.js";
import {
  ScaP03InitialAuthorizationV1,
  ScaP03InitialProposalBindingV1,
} from "../../orchestration/dist/sca/p03-initial-authorization.js";
import { ArtifactRefSchema, validateContract } from "../../orchestration/dist/contracts.js";
import {
  runScaP03InitialLiveCohortV1,
  type ScaP03InitialLiveCohortV1,
} from "../src/p03-initial-cohort.js";

/** A trusted in-process native harness supplies the actual service and same-realm signed token
 * AFTER the parent inspects the closed cohort. Environment flags alone grant no authority.
 * This file never provisions state, issues/activates authority, pulls an image or calls a model. */
const slot = Symbol.for("penny.sca-p03.inspected-live-test-context");
function liveContext(): ScaP03InitialLiveCohortV1 {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, slot);
  const value: unknown = descriptor?.value;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("service" in value) ||
    !(value.service instanceof OrchestrationService) ||
    !("authorization" in value) ||
    !(value.authorization instanceof ScaP03InitialAuthorizationV1) ||
    !("binding" in value) ||
    !(value.binding instanceof ScaP03InitialProposalBindingV1) ||
    !("proposal_ref" in value) ||
    !("transport_ref" in value) ||
    !("approval_token_ref" in value)
  )
    throw new Error(
      "missing_input: same-realm inspected native LIVE context and exact signed approval token"
    );
  return {
    service: value.service,
    authorization: value.authorization,
    binding: value.binding,
    proposal_ref: validateContract(ArtifactRefSchema, value.proposal_ref, "LIVE proposal ref"),
    transport_ref: validateContract(ArtifactRefSchema, value.transport_ref, "LIVE transport ref"),
    approval_token_ref: validateContract(
      ArtifactRefSchema,
      value.approval_token_ref,
      "LIVE approval token ref"
    ),
  };
}
it.skipIf(process.env.PENNY_P03_INITIAL_LIVE !== "1")(
  "LIVE: consumes a fresh native-guarded local-image fixture observation, without claiming formal AC-P03 PASS",
  async () => {
    const result = await runScaP03InitialLiveCohortV1(liveContext(), new AbortController().signal);
    expect(result.evidence.environment.image_ref).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(result.evidence.predecessor_current_admission).toBe("native_current_owner");
    expect(result.evidence.cleanup).toBe("owned_absence_observed");
    expect(result.evidence.original_observations.length).toBeGreaterThan(0);
    expect(result.evidence.cases).toHaveLength(21);
    expect(result.evidence.formal_qualification_granted).toBe(false);
    expect(result.evidence.activation_granted).toBe(false);
    expect(result.evidence.p04_dispatch_permitted).toBe(false);
  },
  600_000
);
