import { describe, expect, it, vi } from "vitest";

import {
  createTestExtensionApi,
  parseJson,
  requireArray,
  requireArrayElement,
  requireDefined,
  requireFunction,
  requireRecord,
  requireString,
} from "./test-narrowers.js";

describe("test fixture narrowers", () => {
  it("returns values only after checking their runtime shape", () => {
    const callback = vi.fn();

    expect(requireDefined("present")).toBe("present");
    expect(requireRecord({ value: 1 })).toEqual({ value: 1 });
    expect(requireString("text")).toBe("text");
    expect(requireArray(["entry"])).toEqual(["entry"]);
    expect(requireArrayElement(["entry"], 0)).toBe("entry");
    expect(requireFunction(callback)).toBe(callback);
    expect(parseJson('{"ok":true}')).toEqual({ ok: true });
  });

  it.each([
    ["undefined value", () => requireDefined(undefined, "missing value"), "missing value"],
    ["null value", () => requireDefined(null, "null value"), "null value"],
    ["missing element", () => requireArrayElement([], 0, "missing element"), "missing element"],
    ["non-record", () => requireRecord([]), "expected an object fixture"],
    ["non-string", () => requireString(42), "expected a string fixture"],
    ["non-array", () => requireArray({}), "expected an array fixture"],
    ["non-function", () => requireFunction("nope"), "expected a function fixture"],
  ])("fails fast for %s", (_label, invoke, message) => {
    expect(invoke).toThrow(message);
  });

  it("exposes registered extension values to typed test hooks", () => {
    const seen: unknown[] = [];
    const api = createTestExtensionApi({
      onRegisterTool: (tool) => seen.push(tool),
      onEvent: (event, handler) => seen.push(event, handler),
    });
    const handler = vi.fn();

    api.registerTool({
      name: "fixture_tool",
      label: "Fixture tool",
      description: "Fixture",
      parameters: { type: "object" },
      execute: vi.fn(),
    });
    api.on("session_start", handler);

    expect(seen).toEqual([
      expect.objectContaining({ name: "fixture_tool" }),
      "session_start",
      handler,
    ]);
  });
});
