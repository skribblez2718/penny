import { describe, expect, it } from "vitest";

import { parseTextResult, requestBody, requireDefined } from "../fixtures.js";

describe("memory test fixture narrowers", () => {
  it("fails fast when a required fixture value is absent", () => {
    expect(() => requireDefined(undefined, "missing memory fixture")).toThrow(
      "missing memory fixture"
    );
    expect(() => requireDefined(null, "null memory fixture")).toThrow("null memory fixture");
  });

  it("rejects missing text results and malformed request bodies", () => {
    expect(() => parseTextResult({ content: [] })).toThrow("expected a text tool result");
    expect(() => requestBody()).toThrow("expected a valid MCP request body");
    expect(() => requestBody({ body: JSON.stringify({ id: "request-without-params" }) })).toThrow(
      "expected a valid MCP request body"
    );
  });
});
