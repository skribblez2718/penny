import { describe, expect, it } from "vitest";

import enhance from "../../index.js";
import {
  createTestExtensionApi,
  isRecord,
  requireFunction,
} from "../../../../lib/tests/test-narrowers.js";

type InputHook = (
  event: { text: string; source: string; streamingBehavior?: "steer" | "followUp" },
  context: { hasUI: boolean }
) => Promise<{ action: "continue" } | { action: "transform"; text: string }>;

function isInputHookResult(value: unknown): value is Awaited<ReturnType<InputHook>> {
  if (!isRecord(value)) return false;
  if (value.action === "continue") return true;
  return value.action === "transform" && typeof value.text === "string";
}

function registerInputHook(): InputHook {
  let registered: unknown;
  const pi = createTestExtensionApi({
    onEvent(event, handler) {
      if (event === "input") registered = handler;
    },
  });

  enhance(pi);
  const hook = requireFunction(registered, "enhance extension did not register an input hook");
  return async (event, context) => {
    const result = await hook(event, context);
    if (!isInputHookResult(result))
      throw new Error("enhance input hook returned an invalid result");
    return result;
  };
}

describe("enhance input hook integration", () => {
  it("consumes the -i flag without invoking a model in a headless context", async () => {
    const hook = registerInputHook();

    await expect(
      hook({ text: "summarize the incident timeline -i", source: "interactive" }, { hasUI: false })
    ).resolves.toEqual({ action: "transform", text: "summarize the incident timeline" });
  });
});
