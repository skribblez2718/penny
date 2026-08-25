import { describe, expect, it } from "vitest";
import type { Directive } from "../src/contracts.js";
import {
  errorCode,
  parseJson,
  requireArray,
  requireArrayItem,
  requireBoolean,
  requireDirectiveAction,
  requireError,
  requireNumber,
  requireRecord,
  requireRecordArray,
  requireRecordValue,
  requireSqlite,
  requireString,
  requireStringArray,
  requireValue,
} from "./helpers/narrowing.js";

describe("test narrowing helpers", () => {
  it("returns present required values", () => {
    expect(requireValue("value", "fixture.value")).toBe("value");
    expect(requireArrayItem(["first"], 0, "fixture.items")).toBe("first");
    expect(requireRecordValue({ key: "value" }, "key", "fixture.record")).toBe("value");
    expect(requireRecord({ key: "value" }, "fixture.record")).toEqual({ key: "value" });
    expect(requireArray(["value"], "fixture.array")).toEqual(["value"]);
    expect(requireRecordArray([{ key: "value" }], "fixture.records")).toEqual([{ key: "value" }]);
    expect(requireString("value", "fixture.string")).toBe("value");
    expect(requireStringArray(["value"], "fixture.strings")).toEqual(["value"]);
    expect(requireNumber(1, "fixture.number")).toBe(1);
    expect(requireBoolean(true, "fixture.boolean")).toBe(true);
    expect(requireError(new Error("expected"), "fixture.error").message).toBe("expected");
    expect(errorCode({ code: "EXPECTED" })).toBe("EXPECTED");
    expect(parseJson('{"key":"value"}')).toEqual({ key: "value" });
  });

  it.each([
    ["null", () => requireValue(null, "fixture.value")],
    ["undefined", () => requireValue(undefined, "fixture.value")],
    ["array item", () => requireArrayItem([], 0, "fixture.items")],
    ["record value", () => requireRecordValue({}, "key", "fixture.record")],
    ["record null", () => requireRecord(null, "fixture.record")],
    ["record array", () => requireRecord([], "fixture.record")],
    ["array", () => requireArray({}, "fixture.array")],
    ["record array", () => requireRecordArray([null], "fixture.records")],
    ["string", () => requireString(1, "fixture.string")],
    ["string array", () => requireStringArray([1], "fixture.strings")],
    ["number", () => requireNumber("1", "fixture.number")],
    ["boolean", () => requireBoolean("true", "fixture.boolean")],
    ["Error", () => requireError("error", "fixture.error")],
    ["SQLite", () => requireSqlite(undefined)],
  ])("fails fast for a missing or invalid %s", (_case, read) => {
    expect(read).toThrow();
  });

  it("discriminates directives and rejects missing or unexpected actions", () => {
    const directive = {
      schema_version: 2,
      action: "complete",
      identity: {
        schema_version: 2,
        run_id: "run_helper",
        session_id: "session_helper",
        playbook: "research",
        engine_owner: "typescript",
      },
      status: "complete",
      met: true,
      result: {},
      artifacts: [],
      unresolved: [],
    } satisfies Directive;
    expect(requireDirectiveAction(directive, "complete", "terminal").met).toBe(true);
    expect(() => requireDirectiveAction(undefined, "complete", "terminal")).toThrow(
      /Missing required value/
    );
    expect(() => requireDirectiveAction(directive, "cancelled", "terminal")).toThrow(
      /Expected terminal\.action to be cancelled/
    );
  });
});
