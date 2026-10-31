import { describe, expect, it, vi } from "vitest";

import { createTestExtensionApi, createTestToolInfos } from "./pi-test-host.js";
import {
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

  it("keeps SDK tool metadata while isolating each provider fixture", () => {
    const tools = createTestToolInfos(["first", "second"]);
    const first = requireArrayElement(tools, 0);
    const second = requireArrayElement(tools, 1);
    expect(tools.map((tool) => tool.name)).toEqual(["first", "second"]);
    expect(first.parameters).not.toBe(second.parameters);
    expect(first.sourceInfo).not.toBe(second.sourceInfo);
    expect(first.sourceInfo).toMatchObject({
      path: "/test-tools/first",
      source: "test-host",
      scope: "project",
      origin: "top-level",
    });
    // Pi 1.x supplies exposure; the baseline predates that metadata field.
    const info = requireRecord(first);
    if (Object.hasOwn(info, "exposure")) expect(info.exposure).toBe("direct");
  });

  it("refuses unmodeled SDK additions instead of invoking the underlying capability", () => {
    const api = createTestExtensionApi();
    const capability = vi.fn();
    // Model an additive SDK method without depending on a particular Pi release.
    Object.assign(api, { futureSdkCapability: capability });
    const invoke = requireFunction(requireRecord(api).futureSdkCapability);
    expect(() => invoke("private fixture input")).toThrow(
      "test ExtensionAPI capability is not implemented: futureSdkCapability"
    );
    expect(capability).not.toHaveBeenCalled();
    expect(requireRecord(createTestExtensionApi()).futureSdkCapability).toBeUndefined();
  });

  it("keeps hooks and event subscriptions private to each fixture", () => {
    const seen: unknown[] = [];
    const first = createTestExtensionApi({ onAppendEntry: (_name, data) => seen.push(data) });
    const second = createTestExtensionApi();
    const receive = vi.fn();
    const unsubscribe = first.events.on("fixture", receive);
    second.events.emit("fixture", "other fixture");
    first.events.emit("fixture", "own fixture");
    unsubscribe();
    first.events.emit("fixture", "after unsubscribe");
    second.appendEntry("fixture", "not forwarded");
    first.appendEntry("fixture", "forwarded");
    expect(receive).toHaveBeenCalledTimes(1);
    expect(receive).toHaveBeenCalledWith("own fixture");
    expect(seen).toEqual(["forwarded"]);
  });

  it("preserves replaceable test methods and refuses unconfigured execution", () => {
    const api = createTestExtensionApi();
    api.appendEntry = vi.fn();
    api.appendEntry("fixture", { value: 1 });
    expect(api.appendEntry).toHaveBeenCalledTimes(1);
    expect(api.appendEntry).toHaveBeenCalledWith("fixture", { value: 1 });
    expect(() => api.exec("unexpected", [])).toThrow(
      "test ExtensionAPI capability is not implemented: exec"
    );
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
    const unsubscribe = requireFunction(api.on("session_start", handler));

    expect(seen).toEqual([
      expect.objectContaining({ name: "fixture_tool" }),
      "session_start",
      handler,
    ]);
    expect(unsubscribe()).toBeUndefined();
  });
});
