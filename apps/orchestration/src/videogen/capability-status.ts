import { Type, type Static } from "typebox";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import { RouteIdSchema } from "./foundation-contracts.js";
import { OpaqueIdSchema as Id, Rfc3339UtcSchema } from "../skill-contracts/common.js";
import type { ArtifactStore } from "../artifact-store.js";
import type { Checkpointer } from "../checkpointer.js";
import { executionState, slot } from "./execution-state.js";
import { VideoRequestV1Schema } from "./foundation-contracts.js";
import { PlaybackReviewV1Schema, NativeBuildResultV1Schema } from "./stage-contracts.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
const closed = { additionalProperties: false } as const;
/** A dossier reports evidence; it never installs profiles, enables providers or issues qualification. */
export const VideogenProductionDossierV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-production-dossier.v1"),
    schema_version: Type.Literal(1),
    context: Type.Union([Type.Literal("production"), Type.Literal("isolated_fixture")]),
    route_id: RouteIdSchema,
    run_id: Id,
    terminal_ref: ArtifactRefSchema,
    manual_review_ref: ArtifactRefSchema,
    qualification_refs: Type.Array(ArtifactRefSchema, {
      minItems: 1,
      maxItems: 128,
      uniqueItems: true,
    }),
    recorded_at_utc: Rfc3339UtcSchema,
  },
  closed
);
export type VideogenProductionDossierV1 = Static<typeof VideogenProductionDossierV1Schema>;
export interface VideogenCapabilityStatusV1 {
  readonly schema_version: 1;
  readonly whole_skill_supported: boolean;
  readonly routes: readonly {
    readonly route_id: string;
    readonly status: "not_run" | "fixture_only" | "production_proven" | "invalid_evidence";
    readonly dossier_ref?: ArtifactRef;
  }[];
}
export function videogenCapabilityStatus(input: {
  readonly store: ArtifactStore;
  readonly checkpointer: Checkpointer;
  readonly dossier_refs: readonly ArtifactRef[];
}): VideogenCapabilityStatusV1 {
  const routes: VideogenCapabilityStatusV1["routes"][number][] = [];
  for (const route_id of Array.from(
    { length: 18 },
    (_, i) => `UC-${String(i + 1).padStart(2, "0")}`
  )) {
    let row: VideogenCapabilityStatusV1["routes"][number] = { route_id, status: "not_run" };
    for (const ref of input.dossier_refs) {
      try {
        if (
          ref.content_schema?.schema_id !== "penny.videogen-production-dossier.v1" ||
          ref.byte_length > 1048576 ||
          canonicalJson(input.store.refById(ref.artifact_id)) !== canonicalJson(ref)
        )
          throw new Error("dossier custody");
        const bytes = input.store.readById(ref.artifact_id);
        if (sha256(bytes) !== ref.content_digest) throw new Error("dossier digest");
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        const d = validateContract(VideogenProductionDossierV1Schema, value, "production dossier");
        if (d.route_id !== route_id) continue;
        if (d.context === "isolated_fixture") {
          row = { route_id, status: "fixture_only", dossier_ref: ref };
          continue;
        }
        const run = input.checkpointer.loadRunById(d.run_id),
          terminal = run?.terminalDirective;
        if (
          run === undefined ||
          terminal?.action !== "complete" ||
          terminal.met !== true ||
          terminal.result.context !== "production" ||
          canonicalJson(terminal.result.output_artifact_ref) !== canonicalJson(d.terminal_ref)
        )
          throw new Error("production run proof missing");
        const state = executionState(run),
          requestRef = slot(state, "request");
        const request = validateContract(
          VideoRequestV1Schema,
          JSON.parse(input.store.readById(requestRef.artifact_id).toString("utf8")),
          "route production request"
        );
        if (request.requested_routes.length !== 1 || request.requested_routes[0] !== route_id)
          throw new Error("one production cannot qualify a different route");
        if (canonicalJson(d.manual_review_ref) !== canonicalJson(slot(state, "playback")))
          throw new Error("manual review is not current run playback");
        const playback = validateContract(
          PlaybackReviewV1Schema,
          JSON.parse(input.store.readById(d.manual_review_ref.artifact_id).toString("utf8")),
          "production playback"
        );
        const native = validateContract(
          NativeBuildResultV1Schema,
          JSON.parse(input.store.readById(slot(state, "native").artifact_id).toString("utf8")),
          "production native"
        );
        if (
          playback.reviewer_kind !== "human" ||
          !playback.complete_viewing ||
          !playback.heard_audio ||
          native.status !== "qualified" ||
          !d.qualification_refs.some(
            (ref) => canonicalJson(ref) === canonicalJson(slot(state, "native"))
          )
        )
          throw new Error("production qualification/manual evidence missing");
        for (const evidence of [d.terminal_ref, d.manual_review_ref, ...d.qualification_refs])
          if (
            canonicalJson(input.store.refById(evidence.artifact_id)) !== canonicalJson(evidence) ||
            sha256(input.store.readById(evidence.artifact_id)) !== evidence.content_digest
          )
            throw new Error("dossier evidence mismatch");
        row = { route_id, status: "production_proven", dossier_ref: ref };
      } catch {
        row = { route_id, status: "invalid_evidence", dossier_ref: ref };
      }
    }
    routes.push(row);
  }
  return {
    schema_version: 1,
    whole_skill_supported: routes.every((x) => x.status === "production_proven"),
    routes,
  };
}
