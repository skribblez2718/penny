import type { HostOperationUseValidatorV1 } from "../host-operations/owner.js";
import { canonicalJson } from "../canonical-json.js";
import { VideogenOwnerSelection, readVideogenOwnerSelection } from "./owner-selection.js";
import { checkGateApproval, type VideogenGateId } from "./gates.js";
import { VideogenRuntime } from "./runtime.js";
const authority: Readonly<Record<string, VideogenGateId>> = Object.freeze({
  voice_capture: "G1",
  draft_apply: "G3",
  shot_prepare: "G3",
  final_apply: "G4",
  rough_build: "G3",
  final_prepare: "G4",
  finish_apply: "G4",
  delivery_apply: "G5",
});
/** Runs before every journal/cache/recovery path, not just adapter.run. This is additional
 * current-gate authority, never a substitute for each concrete provider's own use checks. */
export function videogenUseValidator(runtime: VideogenRuntime): HostOperationUseValidatorV1 {
  return {
    preflightRefs({ directive }) {
      if (authority[directive.state_id] === undefined)
        throw new Error("unregistered videogen effect state");
    },
    validateUse({ directive, signal, reportWorkMilestone }) {
      signal.throwIfAborted();
      const context = runtime.checkpointer.loadRun(directive.identity);
      runtime.assertConfig(context);
      const owner = new VideogenOwnerSelection({
        store: runtime.store,
        checkpointer: runtime.checkpointer,
        project_id: runtime.project_id,
        run_id: context.identity.run_id,
      });
      const host = readVideogenOwnerSelection(owner).gate,
        gate = authority[directive.state_id];
      const approval = host.current_approvals.find((x) => x.gate_id === gate);
      if (gate === undefined || approval === undefined)
        throw new Error("videogen effect has no current gate authority");
      checkGateApproval(host, gate, approval.decision_ref);
      for (const operand of directive.input_artifacts.artifacts)
        if (!context.selectedArtifacts.some((x) => canonicalJson(x) === canonicalJson(operand.ref)))
          throw new Error("videogen effect operand no longer selected");
      reportWorkMilestone();
    },
  };
}
