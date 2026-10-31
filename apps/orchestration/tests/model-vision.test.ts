import { describe, expect, it } from "vitest";

import {
  ModelVisionCapabilityError,
  admitImageInputModel,
  modelSupportsImageInput,
  recheckImageInputModel,
  validateModelImageCapabilityEvidence,
} from "../dist/model-vision.js";

function model(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "fixture-provider",
    id: "fixture-model",
    input: ["text", "image"],
    ...overrides,
  };
}

function expectCode(run: () => unknown, code: ModelVisionCapabilityError["code"]): void {
  try {
    run();
  } catch (error) {
    if (!(error instanceof ModelVisionCapabilityError)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("model image-input capability evidence", () => {
  it("derives deterministic persistable evidence from Pi model metadata", () => {
    const admitted = admitImageInputModel(model({ input: ["image", "text", "image"] }));
    expect(admitted).toEqual({
      schema_version: 1,
      provider: "fixture-provider",
      model: "fixture-model",
      input_modalities: ["image", "text"],
      supports_image_input: true,
      source: "pi_model_metadata",
    });
    const persisted: unknown = JSON.parse(JSON.stringify(admitted));
    expect(validateModelImageCapabilityEvidence(persisted)).toEqual(admitted);
    expect(modelSupportsImageInput(model())).toBe(true);
    expect(modelSupportsImageInput(model({ input: ["text"] }))).toBe(false);
  });

  it("fails closed when identity or capability metadata is missing, malformed, or text-only", () => {
    expectCode(() => admitImageInputModel(undefined), "MODEL_IDENTITY_UNAVAILABLE");
    expectCode(() => admitImageInputModel(model({ provider: "" })), "MODEL_IDENTITY_UNAVAILABLE");
    expectCode(
      () => admitImageInputModel(model({ input: undefined })),
      "MODEL_INPUT_CAPABILITY_UNAVAILABLE"
    );
    expectCode(
      () => admitImageInputModel(model({ input: ["text", 7] })),
      "MODEL_INPUT_CAPABILITY_UNAVAILABLE"
    );
    expectCode(
      () => admitImageInputModel(model({ input: ["text"] })),
      "MODEL_IMAGE_INPUT_UNSUPPORTED"
    );
  });

  it("rejects malformed persisted capability evidence", () => {
    const admitted = admitImageInputModel(model());
    expectCode(
      () => recheckImageInputModel({ ...admitted, input_modalities: ["text", "image"] }, model()),
      "MODEL_CAPABILITY_EVIDENCE_INVALID"
    );
  });

  it("rechecks exact identity and current image support without model-name tables", () => {
    const admitted = admitImageInputModel(model());
    expect(recheckImageInputModel(admitted, model())).toEqual(admitted);
    expectCode(
      () => recheckImageInputModel(admitted, model({ id: "changed-model" })),
      "MODEL_IDENTITY_CHANGED"
    );
    expectCode(
      () => recheckImageInputModel(admitted, model({ input: ["text"] })),
      "MODEL_IMAGE_INPUT_UNSUPPORTED"
    );
  });
});
