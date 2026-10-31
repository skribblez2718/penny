import type { ArtifactRef } from "../contracts.js";
import type { EditDecisionV1 } from "./edit-contracts.js";
import type { ShotResultV1 } from "./stage-contracts.js";

/** The only finalization derivation authorized by an approved rough cut: replace canonical
 * draft picture sources in order. Trims, timing, speech, gain, captions and canvas stay exact. */
export function deriveFinalEdit(
  rough: EditDecisionV1,
  finals: readonly ShotResultV1[],
  ledger: ArtifactRef
) {
  let index = 0;
  const replacements = new Map<string, ArtifactRef>();
  const tracks = rough.tracks.map((track) => ({
    ...track,
    items: track.items.map((item) => {
      if (item.kind !== "clip" || track.kind !== "video") return item;
      let next = replacements.get(item.source_ref.artifact_id);
      if (next === undefined) {
        const result = finals[index++];
        if (result === undefined || result.stage !== "final" || result.disposition !== "accepted")
          throw new Error("final edit requires accepted canonical final shot coverage");
        next = result.clip_ref;
        replacements.set(item.source_ref.artifact_id, next);
      }
      return { ...item, source_ref: next };
    }),
  }));
  if (index !== finals.length) throw new Error("final edit omitted a canonical shot");
  return { edit: { ...rough, tracks, source_dependency_ledger_ref: ledger }, replacements };
}
