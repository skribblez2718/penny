import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ConfinedNativeRunner,
  NATIVE_VERBS,
  type NativeProcessPolicy,
} from "../host-operations/confined-native-runner.js";
import type { ConfinedMediaRunner } from "../host-operations/confined-media-runner.js";
import type { FoundationLimitsV1 } from "./bounds.js";
import type { MediaDecodePolicyV1 } from "./media-contracts.js";
import type { NativePhaseObservation } from "./native-phase-protocol.js";
import {
  compareNativeMedia,
  isNativeMediaComparison,
  type NativeMediaComparisonV1,
} from "./native-media-comparison.js";
import { normalizeObservedNative, writeNativeProject } from "./kdenlive-writer.js";
type WriteInput = Parameters<typeof writeNativeProject>[0];
export interface NativeQualification {
  readonly status: "qualified";
  readonly written: ReturnType<typeof writeNativeProject>;
  readonly normalized_project: Buffer;
  readonly observations: readonly NativePhaseObservation[];
  readonly comparison: NativeMediaComparisonV1;
}
const qualified = new WeakMap<object, () => boolean>();
/** Concrete, noncallback qualification producer. Legacy byte-only drivers cannot enter it.
 * It deliberately does not claim release/package admission, rights or an AV media verdict. */
export async function qualifyNativeProject(input: {
  readonly project: WriteInput;
  readonly native_runner: ConfinedNativeRunner;
  readonly native_policy: NativeProcessPolicy;
  readonly cpu_runner: ConfinedMediaRunner;
  readonly cpu_policy: MediaDecodePolicyV1;
  readonly limits: FoundationLimitsV1;
  readonly accepted_master: Buffer;
  readonly signal: AbortSignal;
}): Promise<NativeQualification> {
  const runner = input.native_runner;
  if (
    !ConfinedNativeRunner.isTrusted(runner) ||
    !runner.supportsPhaseEvidence ||
    runner.editorDigest !== input.project.registry.editor_build_digest
  )
    throw new Error("live pinned native evidence runner required");
  const written = writeNativeProject(input.project);
  let project = written.bytes;
  let normalized = project;
  const observations: NativePhaseObservation[] = [];
  for (const verb of NATIVE_VERBS) {
    const observation = await runner.runObserved({
      verb,
      files: [
        { relative_path: "project.kdenlive", bytes: project },
        ...input.project.assets.map((a) => ({ relative_path: a.relative_path, bytes: a.bytes })),
      ],
      policy: input.native_policy,
      signal: input.signal,
    });
    observations.push(observation);
    if (verb !== "render_compare") {
      normalized = normalizeObservedNative(written, observation, input.project.registry);
      project = verb === "relocate_reopen_readback" ? observation.bytes : normalized;
    }
  }
  const render = observations[3];
  if (render?.header.verb !== "render_compare") throw new Error("native render phase missing");
  const comparison = await compareNativeMedia({
    runner: input.cpu_runner,
    policy: input.cpu_policy,
    limits: input.limits,
    master: input.accepted_master,
    render: render.bytes,
    width: written.readback.canvas.width,
    height: written.readback.canvas.height,
    frame_rate: { numerator: written.readback.canvas.fps, denominator: 1 },
    duration_frames: written.readback.duration_frames,
    signal: input.signal,
  });
  const result: NativeQualification = Object.freeze({
    status: "qualified",
    written,
    normalized_project: normalized,
    observations: Object.freeze(observations),
    comparison,
  });
  const fingerprint = () =>
    sha256(
      canonicalJson({
        written: sha256(result.written.bytes),
        normalized: sha256(result.normalized_project),
        readback: result.written.readback,
        required_paths: result.written.required_paths,
        registry_digest: result.written.registry_digest,
        comparison: result.comparison,
      })
    );
  const original = fingerprint();
  qualified.set(
    result,
    () =>
      fingerprint() === original &&
      result.observations.length === 4 &&
      result.observations.every((o) => ConfinedNativeRunner.isObserved(o)) &&
      isNativeMediaComparison(result.comparison)
  );
  return result;
}
export function isNativeQualification(value: unknown): value is NativeQualification {
  return typeof value === "object" && value !== null && qualified.get(value)?.() === true;
}
