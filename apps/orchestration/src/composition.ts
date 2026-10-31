import { canonicalJson } from "./checkpointer.js";
import {
  validateCanonicalChildWorkflowRequestBytes,
  validateCanonicalEvidenceContextBytes,
} from "./child-workflows/contracts.js";
import type { ArtifactReader } from "./artifact-store.js";
import type { ArtifactRef, InputArtifacts, SkillContract } from "./contracts.js";
import {
  validateCanonicalAssessmentBytes,
  validateCanonicalAssessmentV2Bytes,
} from "./skill-contracts/assess.js";
import { validateCanonicalDecisionBytes } from "./skill-contracts/decide.js";
import { validateCanonicalDiagnosisBytes } from "./skill-contracts/diagnose.js";
import { validateCanonicalSpecificationBytes } from "./skill-contracts/define.js";
import {
  validateCanonicalProducedArtifactBytes,
  validateCanonicalProducedArtifactV2Bytes,
} from "./skill-contracts/produce.js";
import { validateCanonicalGroundedSynthesisBytes } from "./skill-contracts/research.js";
import {
  validateCanonicalStrategyBytes,
  validateCanonicalStrategyV2Bytes,
} from "./skill-contracts/plan.js";

export interface SemanticProductValidatorV1 {
  readonly schema_id: string;
  readonly schema_version: number;
  readonly artifact_kind: string;
  validateCanonicalBytes(bytes: Uint8Array, ref: ArtifactRef): unknown;
}

export const SEMANTIC_PRODUCT_VALIDATORS: ReadonlyMap<string, SemanticProductValidatorV1> = new Map(
  [
    [
      "penny.child-workflow-request.v1",
      {
        schema_id: "penny.child-workflow-request.v1",
        schema_version: 1,
        artifact_kind: "child-request",
        validateCanonicalBytes: validateCanonicalChildWorkflowRequestBytes,
      },
    ],
    [
      "penny.evidence-context.v1",
      {
        schema_id: "penny.evidence-context.v1",
        schema_version: 1,
        artifact_kind: "evidence-context",
        validateCanonicalBytes: validateCanonicalEvidenceContextBytes,
      },
    ],
    [
      "penny.assessment.v1",
      {
        schema_id: "penny.assessment.v1",
        schema_version: 1,
        artifact_kind: "semantic-core",
        validateCanonicalBytes: validateCanonicalAssessmentBytes,
      },
    ],
    [
      "penny.assessment.v2",
      {
        schema_id: "penny.assessment.v2",
        schema_version: 2,
        artifact_kind: "semantic-core",
        validateCanonicalBytes: validateCanonicalAssessmentV2Bytes,
      },
    ],
    [
      "penny.decision.v2",
      {
        schema_id: "penny.decision.v2",
        schema_version: 2,
        artifact_kind: "semantic-core",
        validateCanonicalBytes: validateCanonicalDecisionBytes,
      },
    ],
    [
      "penny.specification.v1",
      {
        schema_id: "penny.specification.v1",
        schema_version: 1,
        artifact_kind: "specification",
        validateCanonicalBytes: validateCanonicalSpecificationBytes,
      },
    ],
    [
      "penny.diagnosis.v1",
      {
        schema_id: "penny.diagnosis.v1",
        schema_version: 1,
        artifact_kind: "semantic-core",
        validateCanonicalBytes: validateCanonicalDiagnosisBytes,
      },
    ],
    [
      "penny.grounded-synthesis.v1",
      {
        schema_id: "penny.grounded-synthesis.v1",
        schema_version: 1,
        artifact_kind: "semantic-core",
        validateCanonicalBytes: validateCanonicalGroundedSynthesisBytes,
      },
    ],
    [
      "penny.strategy.v1",
      {
        schema_id: "penny.strategy.v1",
        schema_version: 1,
        artifact_kind: "strategy",
        validateCanonicalBytes: validateCanonicalStrategyBytes,
      },
    ],
    [
      "penny.strategy.v2",
      {
        schema_id: "penny.strategy.v2",
        schema_version: 2,
        artifact_kind: "strategy",
        validateCanonicalBytes: validateCanonicalStrategyV2Bytes,
      },
    ],
    [
      "penny.produced-artifact.v1",
      {
        schema_id: "penny.produced-artifact.v1",
        schema_version: 1,
        artifact_kind: "semantic-core",
        validateCanonicalBytes: validateCanonicalProducedArtifactBytes,
      },
    ],
    [
      "penny.produced-artifact.v2",
      {
        schema_id: "penny.produced-artifact.v2",
        schema_version: 2,
        artifact_kind: "semantic-core",
        validateCanonicalBytes: validateCanonicalProducedArtifactV2Bytes,
      },
    ],
  ]
);

export type CompositionAdmissionCode =
  | "COMPOSITION_CONTEXT_UNACCEPTED"
  | "COMPOSITION_INPUT_DUPLICATE"
  | "COMPOSITION_ARTIFACT_STALE"
  | "COMPOSITION_PORT_UNMATCHED"
  | "COMPOSITION_PORT_AMBIGUOUS"
  | "COMPOSITION_PORT_CARDINALITY"
  | "COMPOSITION_VALIDATOR_MISSING"
  | "COMPOSITION_SEMANTIC_INVALID";

export class CompositionAdmissionError extends Error {
  constructor(
    readonly code: CompositionAdmissionCode,
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = "CompositionAdmissionError";
  }
}

type InputPort = SkillContract["io"]["input_ports"][number];
type InputSource = "caller" | "prior_skill";

/** Owner-created slots classify authority without inspecting or guessing payload text. */
export function compositionInputSource(slot: string): InputSource {
  return slot === "previous-skill-terminal-output" ||
    slot.startsWith("prior-skill-") ||
    slot.startsWith("prior_")
    ? "prior_skill"
    : "caller";
}

function sourceMatches(port: InputPort, source: InputSource): boolean {
  return port.source === "either" || port.source === source;
}

function schemaMatches(port: InputPort, ref: ArtifactRef): boolean {
  const identity = ref.content_schema;
  if (identity === undefined) {
    // A non-semantic port may deliberately retain compatibility with historical
    // untyped artifacts. Semantic products are never admitted without identity.
    return !port.semantic_product;
  }
  return (
    identity.schema_id === port.schema_id &&
    identity.schema_version === port.schema_version_required
  );
}

function matchingPorts(
  contract: SkillContract,
  binding: InputArtifacts["artifacts"][number]
): InputPort[] {
  const source = compositionInputSource(binding.slot);
  return contract.io.input_ports.filter(
    (port) =>
      port.transport === "artifact" &&
      port.artifact_kind === binding.ref.kind &&
      sourceMatches(port, source) &&
      schemaMatches(port, binding.ref)
  );
}

function exactManifestRef(reader: ArtifactReader, ref: ArtifactRef): ArtifactRef {
  const stored = reader.refById(ref.artifact_id);
  if (stored === undefined || canonicalJson(stored) !== canonicalJson(ref)) {
    throw new CompositionAdmissionError(
      "COMPOSITION_ARTIFACT_STALE",
      `artifact '${ref.artifact_id}' is absent from the manifest, stale, or does not equal its canonical manifest ref`
    );
  }
  return stored;
}

/**
 * Validate all exact composition inputs before RunContext creation or worker/session work.
 * The result preserves the caller's binding order and bytes; it adds no transport wrapper.
 */
export function validateSemanticComposition(input: {
  readonly contract: SkillContract;
  readonly inputArtifacts?: InputArtifacts;
  readonly artifactReader?: ArtifactReader;
  readonly validators?: ReadonlyMap<string, SemanticProductValidatorV1>;
  /** Runtime-owned current completion verification, never inferred from source text. */
  readonly acceptContextProduct?: (ref: ArtifactRef) => void;
}): void {
  const bindings = input.inputArtifacts?.artifacts ?? [];
  const counts = new Map(input.contract.io.input_ports.map((port) => [port.name, 0]));
  const validators = input.validators ?? SEMANTIC_PRODUCT_VALIDATORS;

  const slots = new Set(bindings.map((binding) => binding.slot));
  const ids = new Set(bindings.map((binding) => binding.ref.artifact_id));
  if (
    bindings.some((binding) => binding.designation === "context") &&
    (slots.size !== bindings.length || ids.size !== bindings.length)
  ) {
    throw new CompositionAdmissionError(
      "COMPOSITION_INPUT_DUPLICATE",
      "slots and refs must be unique across native and context inputs"
    );
  }

  for (const binding of bindings) {
    if (binding.designation === "context") {
      if (input.artifactReader === undefined || input.acceptContextProduct === undefined)
        throw new CompositionAdmissionError(
          "COMPOSITION_CONTEXT_UNACCEPTED",
          "context requires runtime-owned accepted-terminal verification"
        );
      const ref = exactManifestRef(input.artifactReader, binding.ref);
      const validator =
        ref.content_schema === undefined ? undefined : validators.get(ref.content_schema.schema_id);
      if (
        validator === undefined ||
        validator.schema_version !== ref.content_schema?.schema_version ||
        validator.artifact_kind !== ref.kind
      )
        throw new CompositionAdmissionError(
          "COMPOSITION_VALIDATOR_MISSING",
          "context has no exact semantic validator"
        );
      const bytes = input.artifactReader.readById(ref.artifact_id);
      try {
        validator.validateCanonicalBytes(bytes, ref);
      } catch {
        throw new CompositionAdmissionError(
          "COMPOSITION_SEMANTIC_INVALID",
          `context '${binding.slot}' failed exact canonical validation`
        );
      }
      input.acceptContextProduct(ref);
      continue;
    }
    const matches = matchingPorts(input.contract, binding);
    if (matches.length === 0) {
      throw new CompositionAdmissionError(
        "COMPOSITION_PORT_UNMATCHED",
        `input '${binding.slot}' (${binding.ref.kind}/${binding.ref.content_schema?.schema_id ?? "untyped"}@${binding.ref.content_schema?.schema_version ?? "untyped"}) matches no contract port`
      );
    }
    if (matches.length !== 1) {
      throw new CompositionAdmissionError(
        "COMPOSITION_PORT_AMBIGUOUS",
        `input '${binding.slot}' matches ${matches.length} contract ports`
      );
    }
    const port = matches[0];
    if (port === undefined) {
      throw new CompositionAdmissionError("COMPOSITION_PORT_UNMATCHED", "resolved port vanished");
    }
    counts.set(port.name, (counts.get(port.name) ?? 0) + 1);

    const reader = input.artifactReader;
    if (reader === undefined) {
      throw new CompositionAdmissionError(
        "COMPOSITION_ARTIFACT_STALE",
        `input '${binding.slot}' requires an exact-byte artifact reader`
      );
    }
    const ref = exactManifestRef(reader, binding.ref);
    const bytes = reader.readById(ref.artifact_id);
    if (!port.semantic_product) continue;
    const validator = validators.get(port.schema_id);
    if (
      validator === undefined ||
      validator.schema_id !== port.schema_id ||
      validator.schema_version !== port.schema_version_required ||
      validator.artifact_kind !== port.artifact_kind
    ) {
      throw new CompositionAdmissionError(
        "COMPOSITION_VALIDATOR_MISSING",
        `semantic port '${port.name}' has no exact registered validator`
      );
    }
    try {
      validator.validateCanonicalBytes(bytes, ref);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "semantic bytes are invalid";
      throw new CompositionAdmissionError(
        "COMPOSITION_SEMANTIC_INVALID",
        `input '${binding.slot}' failed exact-byte validation: ${detail}`
      );
    }
  }

  for (const port of input.contract.io.input_ports) {
    const count = counts.get(port.name) ?? 0;
    if (count < port.min_items || count > port.max_items) {
      throw new CompositionAdmissionError(
        "COMPOSITION_PORT_CARDINALITY",
        `port '${port.name}' requires ${port.min_items}..${port.max_items} item(s), received ${count}`
      );
    }
  }
}
