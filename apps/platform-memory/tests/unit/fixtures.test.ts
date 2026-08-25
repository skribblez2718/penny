import { describe, expect, it } from "vitest";

import {
  requestBody,
  requireArray,
  requireDefined,
  requireRecord,
  requireString,
} from "../fixtures.js";

describe("platform-memory fixture narrowers", () => {
  it("fails fast on missing or wrongly shaped fixture values", () => {
    expect(() => requireDefined(undefined, "missing fixture")).toThrow("missing fixture");
    expect(() => requireRecord([], "record fixture missing")).toThrow("record fixture missing");
    expect(() => requireArray({}, "array fixture missing")).toThrow("array fixture missing");
    expect(() => requireString(42, "string fixture missing")).toThrow("string fixture missing");
  });

  it("rejects missing and malformed MCP request bodies", () => {
    expect(() => requestBody()).toThrow("expected a valid MCP request body");
    expect(() => requestBody({ body: JSON.stringify({ id: "missing-params" }) })).toThrow(
      "expected a valid MCP request body"
    );
  });
});
