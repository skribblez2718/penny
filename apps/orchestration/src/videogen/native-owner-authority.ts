import type { ArtifactRef } from "../contracts.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { readSemantic, sameRef } from "./bounds.js";
import { readVideogenOwnerSelection, type VideogenOwnerSelection } from "./owner-selection.js";
import { DependencyLedgerV1Schema, validateDependencyLedger } from "./rights-ledger.js";
import type { EditHostV1 } from "./edit-decision.js";
import { AudioSourceV1Schema, AudioMeasurementV1Schema } from "./audio-sources.js";
import { EditDecisionV1Schema } from "./edit-contracts.js";
import { executionState, slot } from "./execution-state.js";
import { ShotResultV1Schema } from "./stage-contracts.js";
import type { GatePacketV1 } from "./gates.js";
import { deriveFinalEdit } from "./runtime-final-edit.js";

/** Construction checks identity only; future stage operands need not exist yet. */
export function assertAdapterOwnerBinding(owner: VideogenOwnerSelection, data: EditHostV1): void {
  const { gate } = readVideogenOwnerSelection(owner);
  if (
    data.store !== gate.store ||
    data.project_id !== gate.project_id ||
    data.run_id !== gate.run_id
  )
    throw new Error("adapter concrete owner/project/run mismatch");
}

/** Pure policies may be supplied by the composition root. Authority and source indexes may not.
 * Every use reconstructs them from the same concrete owner's current checkpoint. */
export function currentAdapterHost<T extends EditHostV1>(owner: VideogenOwnerSelection, data: T) {
  assertAdapterOwnerBinding(owner, data);
  const seed = readVideogenOwnerSelection(owner).gate;
  const context = seed.checkpointer.loadRunById(seed.run_id);
  if (
    context === undefined ||
    context === null ||
    context.terminalDirective !== null ||
    ["complete", "incomplete", "error", "cancelled"].includes(context.status)
  )
    throw new Error("adapter active current parent required");
  const { gate, rights } = readVideogenOwnerSelection(owner);
  const selected = context.selectedArtifacts;
  const requireSelected = (refs: readonly ArtifactRef[]): void => {
    if (refs.some((ref) => !selected.some((s) => sameRef(s, ref))))
      throw new Error("adapter current checkpoint operand selection required");
  };
  const ledgerRefs = selected.filter(
    (r) => r.content_schema?.schema_id === "penny.videogen-dependency-ledger.v1"
  );
  // A frozen edit/package keeps its exact source ledger. Later gate bookkeeping must not
  // substitute a newer workflow ledger or make the frozen edit stale merely by appending G5.
  const state =
    context.playbookData.videogen_execution === undefined ? undefined : executionState(context);
  const editRef = state?.slots.find(
    (s) => s.slot === (context.stateId === "rough_build" ? "rough_edit" : "final_edit")
  )?.ref;
  const edit =
    editRef === undefined
      ? undefined
      : readSemantic({
          ...gate,
          ref: editRef,
          schema: EditDecisionV1Schema,
          schema_id: "penny.videogen-edit-decision.v1",
        });
  const ledgerRef =
    edit === undefined
      ? ledgerRefs.length === 1
        ? ledgerRefs[0]
        : undefined
      : ledgerRefs.find((ref) => sameRef(ref, edit.source_dependency_ledger_ref));
  if (ledgerRef === undefined || ledgerRef.run_id !== gate.run_id)
    throw new Error("adapter exact current checkpoint edit ledger required");
  const ledger = validateDependencyLedger(
    readSemantic({
      ...gate,
      ref: ledgerRef,
      schema: DependencyLedgerV1Schema,
      schema_id: "penny.videogen-dependency-ledger.v1",
    }),
    gate.limits
  );
  requireSelected(
    ledger.nodes.flatMap((n) => [
      n.ref,
      ...(n.rights_ref ? [n.rights_ref] : []),
      ...(n.approval_ref ? [n.approval_ref] : []),
    ])
  );
  if (ledger.nodes.some((n) => n.status !== "current")) throw new Error("adapter stale ledger");
  const sources = selected.filter(
    (r) => r.content_schema?.schema_id === "penny.videogen-audio-source.v1"
  );
  const measurements = selected.filter(
    (r) => r.content_schema?.schema_id === "penny.videogen-audio-measurement.v1"
  );
  const audio_sources = sources.map((source_ref) => {
    const source = readSemantic({
      ...gate,
      ref: source_ref,
      schema: AudioSourceV1Schema,
      schema_id: "penny.videogen-audio-source.v1",
    });
    const matches = measurements.filter((ref) => {
      const value = readSemantic({
        ...gate,
        ref,
        schema: AudioMeasurementV1Schema,
        schema_id: "penny.videogen-audio-measurement.v1",
      });
      return (
        sameRef(value.source_ref, source.media_ref) &&
        sameRef(value.decode_receipt_ref, source.decoded_audio_ref)
      );
    });
    const measurement_ref = matches[0];
    if (matches.length !== 1 || measurement_ref === undefined)
      throw new Error("adapter selected audio measurement required");
    return { source_ref, measurement_ref };
  });
  const host = {
    ...data,
    ...gate,
    ...rights,
    current_dependencies: ledger.nodes.map((n) => ({
      stable_id: n.stable_id,
      ref: n.ref,
      revision: n.revision,
    })),
    measured_source_refs: selected.filter(
      (r) => r.content_schema?.schema_id === "penny.videogen-edit-source.v1"
    ),
    audio_sources,
  };
  return {
    host,
    ledger_ref: ledgerRef,
    requireSelected,
    source_sha256: sha256(canonicalJson(context.snapshot())),
    assertUnchanged: (): void => {
      const fresh = gate.checkpointer.loadRunById(gate.run_id);
      if (
        fresh === undefined ||
        fresh === null ||
        sha256(canonicalJson(fresh.snapshot())) !== sha256(canonicalJson(context.snapshot()))
      )
        throw new Error("adapter parent source checkpoint changed");
    },
  };
}

/** G4 approves the rough cut and a bounded final campaign, not a nonexistent future edit.
 * Existing directly presented edit requests retain exact binding; derived finals must be the
 * current host-sealed descendant and exactly reproduce the permitted replacement operation. */
export function assertNativeG4Lineage(
  owner: VideogenOwnerSelection,
  editRef: ArtifactRef,
  packet: GatePacketV1,
  decisionRef: ArtifactRef
): void {
  const { gate } = readVideogenOwnerSelection(owner);
  if (
    packet.kind !== "approval" ||
    packet.gate_id !== "G4" ||
    !packet.effect_scope.kinds.includes("kdenlive_build_verify")
  )
    throw new Error("current G4 native scope required");
  if (packet.presented.some((p) => sameRef(p.ref, editRef))) return;
  const context = gate.checkpointer.loadRunById(gate.run_id);
  if (context === undefined || context === null) throw new Error("native current parent missing");
  const state = executionState(context),
    roughRef = slot(state, "rough_edit");
  if (
    !sameRef(slot(state, "final_edit"), editRef) ||
    !sameRef(slot(state, "G4"), decisionRef) ||
    !packet.presented.some((p) => p.role === "rough-cut" && sameRef(p.ref, roughRef))
  )
    throw new Error("native final edit is not the current G4 rough-cut descendant");
  const selected = (ref: ArtifactRef) => context.selectedArtifacts.some((s) => sameRef(s, ref));
  const finalRefs = state.shot_ids.map((id) => slot(state, `final-${id}`));
  if (![roughRef, editRef, decisionRef, ...finalRefs].every(selected))
    throw new Error("native final lineage no longer selected");
  const upstream = gate.store.metadata(editRef).upstream_refs;
  if (
    editRef.producer !== "host:videogen" ||
    ![roughRef, decisionRef, ...finalRefs].every((ref) => upstream.some((r) => sameRef(r, ref)))
  )
    throw new Error("native final host derivation lineage required");
  const rough = readSemantic({
    ...gate,
    ref: roughRef,
    schema: EditDecisionV1Schema,
    schema_id: "penny.videogen-edit-decision.v1",
  });
  const edit = readSemantic({
    ...gate,
    ref: editRef,
    schema: EditDecisionV1Schema,
    schema_id: "penny.videogen-edit-decision.v1",
  });
  const finals = finalRefs.map((ref, index) => {
    const value = readSemantic({
      ...gate,
      ref,
      schema: ShotResultV1Schema,
      schema_id: "penny.videogen-shot-result.v1",
    });
    if (
      value.shot_id !== state.shot_ids[index] ||
      !packet.effect_scope.subject_ids.includes(value.shot_id)
    )
      throw new Error("native final shot outside approved G4 scope");
    return value;
  });
  if (
    canonicalJson(deriveFinalEdit(rough, finals, edit.source_dependency_ledger_ref).edit) !==
    canonicalJson(edit)
  )
    throw new Error("native final edit changed approved rough timing or non-picture semantics");
}
