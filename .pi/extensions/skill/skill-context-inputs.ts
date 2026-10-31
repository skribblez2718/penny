import type { ArtifactRef } from "./artifact-client.js";
import { parseInputArtifacts, type InputArtifactsV2 } from "./input-artifacts.js";

/** Explicit selection across every existing mode. Never silently upgrade/downgrade context. */
export function skillArtifactInputs(input: {
  nativeRefs: readonly ArtifactRef[];
  contextRefs: readonly ArtifactRef[];
  chainInput?: InputArtifactsV2 | undefined;
}): InputArtifactsV2 | undefined {
  const bindings: InputArtifactsV2["artifacts"] = [
    ...(input.chainInput?.artifacts ?? []),
    ...input.nativeRefs.map((ref, index) => ({
      slot: `caller-input-${String(index + 1).padStart(4, "0")}`,
      ref,
    })),
    ...input.contextRefs.map((ref, index) => ({
      slot: `context-input-${String(index + 1).padStart(4, "0")}`,
      designation: "context" as const,
      ref,
    })),
  ];
  const unique = new Map<string, (typeof bindings)[number]>();
  for (const binding of bindings) {
    const prior = unique.get(binding.ref.artifact_id);
    if (prior !== undefined) {
      if ((prior.designation ?? "binding") !== (binding.designation ?? "binding"))
        throw new Error(
          "CONTEXT_BINDING_CONFLICT: an artifact cannot be both context and native input"
        );
      // Retain the existing native chain duplicate behavior; context slots remain exact.
      if (binding.designation === "context")
        throw new Error("CONTEXT_BINDING_CONFLICT: duplicate context artifact");
      continue;
    }
    unique.set(binding.ref.artifact_id, binding);
  }
  return unique.size === 0
    ? undefined
    : parseInputArtifacts({ schema_version: 2, artifacts: [...unique.values()] });
}
