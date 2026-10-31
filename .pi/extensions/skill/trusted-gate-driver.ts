import type { OrchestrationService } from "@penny/orchestration/service";
import { JsonValueSchema, validateContract } from "@penny/orchestration/contracts";
import { verifyExecutionOwnerSignature } from "./execution-receipts.js";

/** Native-only companion to ordinary clarification forwarding. Ordinary respond remains data;
 * this helper never manufactures a witness, maps an operator, or exports the realm HMAC secret.
 * Registration-specific resume validation still owns proposal/principal/policy/time admission. */
export async function respondToTrustedNativeGateV1(input: {
  readonly service: Pick<OrchestrationService, "checkpointer" | "execute">;
  readonly run_id: string;
  readonly event: unknown;
  readonly signal: AbortSignal;
}) {
  input.signal.throwIfAborted();
  if (!verifyExecutionOwnerSignature(input.event))
    throw new Error("trusted_native_gate_signature_invalid");
  const response = validateContract(JsonValueSchema, input.event, "trusted native gate event");
  const run = input.service.checkpointer.loadRunById(input.run_id);
  if (run === undefined || run.pendingDirective?.action !== "await_user")
    throw new Error("trusted_native_gate_pending_required");
  const gate = run.pendingDirective;
  return input.service.execute(
    {
      schema_version: 2,
      action: "respond",
      identity: gate.identity,
      gate_id: gate.gate_id,
      challenge: gate.challenge,
      response,
    },
    input.signal
  );
}
