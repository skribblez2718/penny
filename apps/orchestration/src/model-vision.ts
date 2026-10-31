/** Persistable evidence derived only from Pi's resolved model metadata. */
export interface ModelImageCapabilityEvidenceV1 {
  readonly schema_version: 1;
  readonly provider: string;
  readonly model: string;
  readonly input_modalities: readonly string[];
  readonly supports_image_input: true;
  readonly source: "pi_model_metadata";
}

export type ModelVisionCapabilityErrorCode =
  | "MODEL_IDENTITY_UNAVAILABLE"
  | "MODEL_INPUT_CAPABILITY_UNAVAILABLE"
  | "MODEL_IMAGE_INPUT_UNSUPPORTED"
  | "MODEL_CAPABILITY_EVIDENCE_INVALID"
  | "MODEL_IDENTITY_CHANGED";

export class ModelVisionCapabilityError extends Error {
  constructor(
    readonly code: ModelVisionCapabilityErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ModelVisionCapabilityError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function identity(model: unknown): { readonly provider: string; readonly model: string } {
  if (!isRecord(model)) {
    throw new ModelVisionCapabilityError(
      "MODEL_IDENTITY_UNAVAILABLE",
      "resolved model metadata is unavailable"
    );
  }
  const provider = typeof model.provider === "string" ? model.provider.trim() : "";
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (provider.length === 0 || id.length === 0) {
    throw new ModelVisionCapabilityError(
      "MODEL_IDENTITY_UNAVAILABLE",
      "resolved model identity is unavailable"
    );
  }
  return { provider, model: id };
}

function inputModalities(model: unknown): readonly string[] {
  if (!isRecord(model) || !Array.isArray(model.input)) {
    throw new ModelVisionCapabilityError(
      "MODEL_INPUT_CAPABILITY_UNAVAILABLE",
      "resolved model input capability metadata is unavailable"
    );
  }
  if (!model.input.every(isNonEmptyString)) {
    throw new ModelVisionCapabilityError(
      "MODEL_INPUT_CAPABILITY_UNAVAILABLE",
      "resolved model input capability metadata is malformed"
    );
  }
  return [...new Set(model.input)].sort();
}

export function validateModelImageCapabilityEvidence(
  value: unknown
): ModelImageCapabilityEvidenceV1 {
  if (!isRecord(value)) {
    throw new ModelVisionCapabilityError(
      "MODEL_CAPABILITY_EVIDENCE_INVALID",
      "model image capability evidence is not an object"
    );
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "input_modalities",
    "model",
    "provider",
    "schema_version",
    "source",
    "supports_image_input",
  ];
  if (
    keys.join("\0") !== expectedKeys.join("\0") ||
    value.schema_version !== 1 ||
    !isNonEmptyString(value.provider) ||
    value.provider.trim() !== value.provider ||
    !isNonEmptyString(value.model) ||
    value.model.trim() !== value.model ||
    !Array.isArray(value.input_modalities) ||
    !value.input_modalities.every(isNonEmptyString) ||
    value.supports_image_input !== true ||
    value.source !== "pi_model_metadata"
  ) {
    throw new ModelVisionCapabilityError(
      "MODEL_CAPABILITY_EVIDENCE_INVALID",
      "model image capability evidence is malformed or noncanonical"
    );
  }
  const modalities = value.input_modalities;
  if (
    [...new Set(modalities)].sort().join("\0") !== modalities.join("\0") ||
    !modalities.includes("image")
  ) {
    throw new ModelVisionCapabilityError(
      "MODEL_CAPABILITY_EVIDENCE_INVALID",
      "model image capability evidence is malformed or noncanonical"
    );
  }
  return Object.freeze({
    schema_version: 1,
    provider: value.provider,
    model: value.model,
    input_modalities: Object.freeze([...modalities]),
    supports_image_input: true,
    source: "pi_model_metadata",
  });
}

/** Capability probe for UI/routing only; security admission uses admitImageInputModel. */
export function modelSupportsImageInput(model: unknown): boolean {
  try {
    return inputModalities(model).includes("image");
  } catch {
    return false;
  }
}

/** Resolve exact identity plus positive image-input evidence, or fail closed. */
export function admitImageInputModel(model: unknown): ModelImageCapabilityEvidenceV1 {
  const resolvedIdentity = identity(model);
  const modalities = inputModalities(model);
  if (!modalities.includes("image")) {
    throw new ModelVisionCapabilityError(
      "MODEL_IMAGE_INPUT_UNSUPPORTED",
      `resolved model '${resolvedIdentity.provider}/${resolvedIdentity.model}' does not advertise image input`
    );
  }
  return Object.freeze({
    schema_version: 1,
    provider: resolvedIdentity.provider,
    model: resolvedIdentity.model,
    input_modalities: Object.freeze(modalities),
    supports_image_input: true,
    source: "pi_model_metadata",
  });
}

/** Re-resolve immediately before dispatch and bind to the previously admitted identity. */
export function recheckImageInputModel(
  admitted: ModelImageCapabilityEvidenceV1,
  activeModel: unknown
): ModelImageCapabilityEvidenceV1 {
  const expected = validateModelImageCapabilityEvidence(admitted);
  const current = admitImageInputModel(activeModel);
  if (current.provider !== expected.provider || current.model !== expected.model) {
    throw new ModelVisionCapabilityError(
      "MODEL_IDENTITY_CHANGED",
      `active model '${current.provider}/${current.model}' differs from admitted model '${expected.provider}/${expected.model}'`
    );
  }
  return current;
}
