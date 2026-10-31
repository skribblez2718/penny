/** Registry discovery is intentionally dependency-light: importing a decoder, editor or proof
 * module cannot recursively instantiate the executor while its schemas are still initializing. */
import type { PlaybookRegistration } from "./registry.js";
import { VIDEOGEN_SKILL_CONTRACT } from "./videogen-contract.js";
import { VIDEOGEN_HOST_STATES, VIDEOGEN_WORKER_PHASES } from "../videogen/matrix.js";
import { VIDEOGEN_COMPLETION_PREDICATE_IDS } from "../videogen/completion-policy.js";
import { ordinaryLivenessPolicy } from "../liveness.js";
import { VideoRequestV1Schema } from "../videogen/foundation-contracts.js";
function missing(): never {
  throw new Error(
    "VIDEOGEN_PRIVATE_CONFIG_MISSING: explicit private activation and concrete providers are required"
  );
}
/** Disabled exact-name discovery only. No run or proof can be admitted by this registration.
 * The service replaces it with createVideogenRegistration(privateProviders), whose seven real
 * proof evaluators are fixed code and cannot be supplied or overridden by a provider. */
export const VIDEOGEN_PLAYBOOK_REGISTRATION: PlaybookRegistration =
  Object.freeze<PlaybookRegistration>({
    name: "videogen",
    contract: VIDEOGEN_SKILL_CONTRACT,
    ingress: "skill",
    start_admission: {
      schema_id: "penny.videogen-request.v1",
      schema_version: 1,
      prepare: missing,
      materialize: missing,
    },
    caller_documentation: {
      constraints_schema: VideoRequestV1Schema,
      example: {
        goal: "Produce a bounded film from caller-approved private profiles.",
        constraints: {},
      },
      semantic_caveat:
        "Hidden exact-name workflow; explicit private activation and concrete providers are required. Fixtures do not qualify production.",
    },
    liveness: {
      resolver_id: "videogenLivenessPolicy",
      resolve: () => ordinaryLivenessPolicy({ scope: "videogen", preset: "standard" }),
      thinking_policy: "agent_ssot",
    },
    worker: {
      kind: "catalog-agent",
      workflow_name: "videogen",
      guidance: VIDEOGEN_SKILL_CONTRACT.guidance,
      guidance_required: true,
      result_transport: "persisted_summary",
      opening_policy: "registration_guidance_task_artifacts",
      model_policy: "directive_override_or_runtime_default",
      phases: VIDEOGEN_WORKER_PHASES,
    },
    host_states: VIDEOGEN_HOST_STATES,
    completionReceiptPredicates: new Map(
      VIDEOGEN_COMPLETION_PREDICATE_IDS.map((id) => [id, missing])
    ),
    construct: () => ({
      initialize: missing,
      dispatch: missing,
      resume: missing,
      cancel: missing,
      acceptSummary: missing,
      rebindPendingDirective: missing,
    }),
  });
