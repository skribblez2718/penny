import type { ArtifactStore } from "../artifact-store.js";
import type { ArtifactRef } from "../contracts.js";
import { exactRef } from "./bounds.js";
import { validateGateDecision } from "./gates.js";
import { Type } from "typebox";
import { validateContract } from "../contracts.js";
import { validateFoundationLimits } from "./bounds.js";
import { assertUnique } from "../skill-contracts/common.js";
import { readExact, type FoundationLimitsV1 } from "./bounds.js";
import { readVideogenStageProduct } from "./semantic-catalog.js";
import { validateCanonicalPng } from "../png-media.js";
import {
  VIDEOGEN_TERMINALS,
  VIDEOGEN_OPTIONAL_CHILD_PARENTS,
  VIDEOGEN_SYNTHESIS_VERIFIERS,
} from "./matrix.js";
export interface VideogenStatePortV1 {
  readonly name: string;
  readonly schema_id: string | null;
  readonly min_items: number;
  readonly max_items: number | null;
}
const one = (name: string, schema: string): VideogenStatePortV1 => ({
  name,
  schema_id: `penny.videogen-${schema}.v1`,
  min_items: 1,
  max_items: 1,
});
const raw = (name: string): VideogenStatePortV1 => ({
  name,
  schema_id: null,
  min_items: 1,
  max_items: 1,
});
const optional = (name: string, schema: string): VideogenStatePortV1 => ({
  ...one(name, schema),
  min_items: 0,
});
const many = (name: string, schema: string | null, min = 1): VideogenStatePortV1 => ({
  name,
  schema_id: schema === null ? null : `penny.videogen-${schema}.v1`,
  min_items: min,
  max_items: null,
});
/** Literal artifact ports from CONTRACTS. Host-only scalar controls are checked separately.
 * Q/L and all applicable prior gates are inherited, even where the matrix abbreviates them. */
export const VIDEOGEN_STATE_PORTS: Readonly<Record<string, readonly VideogenStatePortV1[]>> = {
  admit: [one("request", "request")],
  brief_analysis: [one("request", "request"), many("context", null, 0)],
  research_fact: [one("brief", "brief-analysis"), many("source", null)],
  story_options: [one("brief", "brief-analysis")],
  story_choice: [one("options", "story-options")],
  story_plan: [one("brief", "brief-analysis"), optional("options", "story-choice")],
  script_text: [one("outline", "story-outline")],
  story_check: [one("outline", "story-outline"), one("script", "script")],
  g1: [one("canon", "story-canon"), many("asset_intents", "asset-intent")],
  asset_prepare: [
    one("canon", "story-canon"),
    one("G1", "gate-decision"),
    many("intents", "asset-intent"),
  ],
  image_child: [one("intent", "asset-intent"), one("G1", "gate-decision")],
  voice_capture: [
    one("intent", "asset-intent"),
    one("script", "script"),
    one("G1", "gate-decision"),
  ],
  look_check: [
    one("assets", "admitted-asset-ledger"),
    one("canon", "story-canon"),
    many("audio", "audio-evidence"),
  ],
  reference_verify: [
    one("look", "look-review"),
    many("png_evidence", null),
    many("audio", "audio-evidence"),
  ],
  reference_critique: [
    one("verified", "review-binding"),
    many("png_evidence", null),
    many("audio", "audio-evidence"),
  ],
  g2: [one("look", "look-voice"), many("references", "review-binding"), one("G1", "gate-decision")],
  animatic_plan: [
    one("canon", "story-canon"),
    one("look", "look-voice"),
    one("G2", "gate-decision"),
  ],
  animatic_build: [
    one("plan", "animatic-plan"),
    one("look", "look-voice"),
    one("G2", "gate-decision"),
  ],
  g3: [one("animatic", "animatic"), one("G2", "gate-decision")],
  route_choice: [
    one("shot", "shot-route"),
    one("animatic", "animatic"),
    one("G3", "gate-decision"),
  ],
  shot_prepare: [
    one("shot", "shot-route"),
    one("look", "look-voice"),
    one("G3", "gate-decision"),
    optional("route", "route-choice"),
  ],
  draft_apply: [
    optional("graph", "prepared-graph"),
    one("shot", "shot-route"),
    one("G3", "gate-decision"),
  ],
  draft_verify: [
    one("shot", "shot-media"),
    one("evidence", "video-evidence"),
    one("G3", "gate-decision"),
  ],
  draft_critique: [
    one("shot", "shot-media"),
    one("verified", "review-binding"),
    one("G3", "gate-decision"),
  ],
  rough_build: [
    many("drafts", "shot-result"),
    many("voice", "audio-source"),
    one("G3", "gate-decision"),
  ],
  rough_review: [
    one("rough", "edit-decision"),
    one("evidence", "video-evidence"),
    one("audio", "audio-evidence"),
  ],
  rough_critique: [one("rough", "edit-decision"), one("verified", "review-binding")],
  g4: [one("rough", "edit-decision"), many("review", "review-binding"), one("G3", "gate-decision")],
  final_prepare: [
    one("shot", "shot-result"),
    one("G4", "gate-decision"),
    one("look", "look-voice"),
  ],
  final_apply: [one("graph", "prepared-graph"), one("G4", "gate-decision")],
  final_verify: [
    one("shot", "shot-media"),
    one("evidence", "video-evidence"),
    one("G4", "gate-decision"),
  ],
  final_critique: [
    one("shot", "shot-media"),
    one("verified", "review-binding"),
    one("G4", "gate-decision"),
  ],
  finish_prepare: [
    many("finals", "shot-result"),
    one("rough", "edit-decision"),
    many("audio", "audio-source"),
    one("G4", "gate-decision"),
  ],
  finish_apply: [
    one("edit", "edit-decision"),
    one("native_request", "native-build-request"),
    one("G4", "gate-decision"),
  ],
  master_verify: [
    raw("master"),
    one("video", "video-evidence"),
    one("audio", "audio-evidence"),
    one("package", "portable-package"),
    one("native", "native-build-result"),
  ],
  master_critique: [
    raw("master"),
    one("frames", "video-evidence"),
    one("verified", "review-binding"),
  ],
  g5: [
    one("master", "master-review"),
    one("package", "package-review"),
    one("playback", "playback-review"),
    one("G4", "gate-decision"),
  ],
  delivery_prepare: [raw("master"), one("package", "portable-package"), one("G5", "gate-decision")],
  delivery_apply: [one("intent", "delivery-intent"), one("G5", "gate-decision")],
  completion_check: [
    one("terminal", "terminal"),
    one("delivery", "delivery-receipt"),
    one("G5", "gate-decision"),
  ],
  clarify: [one("packet", "gate-packet")],
  child_call: [raw("child_request"), many("child_inputs", null, 0)],
  evidence_synthesis: [many("conflicting_evidence", null)],
  delivered: [one("terminal", "terminal")],
  incomplete: [one("terminal", "terminal")],
  cancelled: [one("terminal", "terminal")],
  error: [one("terminal", "terminal")],
};
const applicableGateEpochs = [
  [
    "asset_prepare",
    "image_child",
    "voice_capture",
    "look_check",
    "reference_verify",
    "reference_critique",
    "g2",
  ],
  ["animatic_plan", "animatic_build", "g3"],
  [
    "route_choice",
    "shot_prepare",
    "draft_apply",
    "draft_verify",
    "draft_critique",
    "rough_build",
    "rough_review",
    "rough_critique",
    "g4",
  ],
  [
    "final_prepare",
    "final_apply",
    "final_verify",
    "final_critique",
    "finish_prepare",
    "finish_apply",
    "master_verify",
    "master_critique",
    "g5",
  ],
  ["delivery_prepare", "delivery_apply", "completion_check"],
];
const gateIds = ["G1", "G2", "G3", "G4", "G5"];
/** Descriptor inspection may omit origin. Dispatch preflight must validate exact host scalar controls. */
export function videogenStatePorts(
  state: string,
  host_origin?: string
): readonly VideogenStatePortV1[] {
  const ports = VIDEOGEN_STATE_PORTS[state];
  if (ports === undefined) throw new Error(`unknown videogen state: ${state}`);
  if (state === "admit" || VIDEOGEN_TERMINALS.some((x) => x === state)) return ports;
  const epoch = applicableGateEpochs.findIndex((group) => group.includes(host_origin ?? state));
  const inheritedGates =
    epoch < 0
      ? []
      : gateIds
          .slice(0, epoch + 1)
          .filter((name) => !ports.some((port) => port.name === name))
          .map((name) => one(name, "gate-decision"));
  return [
    one("Q", "envelope"),
    one("L", "dependency-ledger"),
    ...inheritedGates,
    ...ports,
    ...(VIDEOGEN_OPTIONAL_CHILD_PARENTS.includes(state)
      ? [{ ...raw("information"), min_items: 0 }]
      : []),
    ...(VIDEOGEN_SYNTHESIS_VERIFIERS.includes(state)
      ? [optional("synthesis", "evidence-synthesis")]
      : []),
  ];
}
export interface VideogenExactInputV1 {
  readonly slot: string;
  readonly ref: ArtifactRef;
}
/** Structural/exact-custody preflight only. It grants no gate, rights, effect or completion authority.
 * Plural ports use contiguous names <port>-0, <port>-1, ...; scalar ports use their exact name.
 * Semantic byte validators are deliberately required from the fixed schema catalog, never optional.
 */
export function preflightVideogenStateInputs(input: {
  readonly state: string;
  readonly artifacts: ArtifactStore;
  readonly project_id: string;
  readonly limits: FoundationLimitsV1;
  readonly max_input_bytes: number;
  readonly bindings: readonly VideogenExactInputV1[];
  readonly controls?: unknown;
}): void {
  validateFoundationLimits(input.limits);
  let hostOrigin: string | undefined;
  if (input.state === "child_call")
    hostOrigin = validateContract(
      Type.Object(
        {
          parent_state: Type.Union(
            VIDEOGEN_OPTIONAL_CHILD_PARENTS.map((value) => Type.Literal(value))
          ),
        },
        { additionalProperties: false }
      ),
      input.controls,
      "videogen child controls"
    ).parent_state;
  else if (input.state === "evidence_synthesis")
    hostOrigin = validateContract(
      Type.Object(
        {
          return_state: Type.Union(
            VIDEOGEN_SYNTHESIS_VERIFIERS.map((value) => Type.Literal(value))
          ),
        },
        { additionalProperties: false }
      ),
      input.controls,
      "videogen synthesis controls"
    ).return_state;
  else if (input.controls !== undefined)
    throw new Error("videogen unexpected host scalar controls");
  if (!Number.isSafeInteger(input.max_input_bytes) || input.max_input_bytes < 1)
    throw new Error("finite videogen input byte policy required");
  if (input.bindings.length > input.limits.max_collection_items)
    throw new Error("videogen state input count limit");
  for (const row of input.bindings) exactRef(row.ref);
  if (
    input.bindings.reduce((sum, row) => sum + BigInt(row.ref.byte_length), 0n) >
    BigInt(input.max_input_bytes)
  )
    throw new Error("videogen aggregate input byte limit");
  const ports = videogenStatePorts(input.state, hostOrigin);
  assertUnique(
    input.bindings.map((x) => x.slot),
    "videogen input slots"
  );
  if (input.bindings.length > input.limits.max_collection_items)
    throw new Error("videogen state input count limit");
  const consumed = new Set<string>();
  for (const port of ports) {
    const rows = input.bindings.filter((row) =>
      port.max_items === 1 ? row.slot === port.name : row.slot.startsWith(`${port.name}-`)
    );
    if (rows.length < port.min_items || (port.max_items !== null && rows.length > port.max_items))
      throw new Error(`videogen ${input.state}.${port.name} cardinality`);
    if (
      port.name === "conflicting_evidence" &&
      (rows.length < 2 || new Set(rows.map((row) => row.ref.artifact_id)).size < 2)
    )
      throw new Error("videogen synthesis requires two distinct captured evidence refs");
    if (port.max_items === null) {
      const names = new Set(rows.map((row) => row.slot));
      for (let index = 0; index < rows.length; index++)
        if (!names.has(`${port.name}-${index}`))
          throw new Error(`videogen noncontiguous ${port.name} inputs`);
    }
    for (const row of rows) {
      consumed.add(row.slot);
      readExact(input.artifacts, input.project_id, row.ref, input.max_input_bytes);
      if (port.schema_id !== null) {
        if (
          row.ref.content_schema?.schema_id !== port.schema_id ||
          row.ref.content_schema.schema_version !== 1
        )
          throw new Error(`videogen ${row.slot} semantic port mismatch`);
        const product = readVideogenStageProduct({
          ...input,
          ref: row.ref,
          schema_id: port.schema_id,
        });
        if (gateIds.includes(port.name)) {
          const gate = validateGateDecision(product, input.limits);
          if (gate.gate_id !== port.name || gate.choice !== "approve")
            throw new Error("videogen applicable approved gate required");
        }
      }
      if (port.name === "png_evidence") {
        if (row.ref.media_type !== "image/png")
          throw new Error("reference evidence must be canonical PNG");
        validateCanonicalPng(
          readExact(input.artifacts, input.project_id, row.ref, input.max_input_bytes)
        );
      }
    }
  }
  if (input.bindings.some((row) => !consumed.has(row.slot)))
    throw new Error("videogen undeclared input slot");
}
