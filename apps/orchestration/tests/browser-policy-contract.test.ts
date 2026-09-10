import { describe, expect, it } from "vitest";

import {
  MAX_BROWSER_POLICY_ID_CHARS,
  browserNetworkDefaultPortV1,
  canonicalBrowserNetworkAllowlistV1,
  canonicalBrowserNetworkPatternValueV1,
  isBrowserNetworkSchemeV1,
  normalizeBrowserNetworkHostnameV1,
  parseBrowserNetworkAllowlistV1,
  validateBrowserPolicyCarrierIdV1,
  validateRegisteredBrowserPolicyCarrierV1,
} from "../src/browser-policy-contract-v1.js";

describe("browser policy wire contract v1", () => {
  it("canonicalizes one bounded pattern grammar for every producer and consumer", () => {
    const parsed = parseBrowserNetworkAllowlistV1([
      "HTTPS://Exämple.COM",
      "https://xn--exmple-cua.com:443",
      "127.1:8080",
      "[0:0:0:0:0:0:0:1]:9000",
      "WSS://*.Example.COM:9443",
    ]);
    expect(parsed.map((pattern) => pattern.canonical)).toEqual([
      "127.0.0.1:8080",
      "[::1]:9000",
      "https://xn--exmple-cua.com:443",
      "wss://*.example.com:9443",
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.every((pattern) => Object.isFrozen(pattern))).toBe(true);
    expect(isBrowserNetworkSchemeV1("wss")).toBe(true);
    expect(isBrowserNetworkSchemeV1("file")).toBe(false);
    expect(browserNetworkDefaultPortV1("https")).toBe(443);
    expect(normalizeBrowserNetworkHostnameV1("Example.COM.")).toBe("example.com");
    expect(
      canonicalBrowserNetworkPatternValueV1({
        scheme: "https",
        hostname: "example.com",
        includeSubdomains: true,
        port: 443,
      })
    ).toBe("https://*.example.com:443");
  });

  it("applies the exact same 128-character identity bound to every carrier field", () => {
    const maximum = "a".repeat(MAX_BROWSER_POLICY_ID_CHARS);
    expect(validateBrowserPolicyCarrierIdV1(maximum, "identity")).toBe(maximum);
    expect(() => validateBrowserPolicyCarrierIdV1(`${maximum}a`, "identity")).toThrow(
      /1-128 characters/
    );

    const allowlist = canonicalBrowserNetworkAllowlistV1(["https://allowed.example"]);
    for (const field of [
      "owner_scope_id",
      "invocation_id",
      "registration_name",
      "state_id",
    ] as const) {
      const candidate = {
        schema_version: 1,
        source: "orchestration-registration",
        owner_scope_id: "owner",
        invocation_id: "invocation",
        registration_name: "registration",
        state_id: "state",
        allowlist,
        [field]: `${maximum}a`,
      };
      expect(() => validateRegisteredBrowserPolicyCarrierV1(candidate), field).toThrow(
        /1-128 characters/
      );
    }
  });

  it("accepts only the immutable orchestration-registration carrier", () => {
    const allowlist = canonicalBrowserNetworkAllowlistV1(["https://allowed.example"]);
    expect(
      validateRegisteredBrowserPolicyCarrierV1(
        Object.freeze({
          schema_version: 1,
          source: "orchestration-registration",
          owner_scope_id: "owner",
          invocation_id: "invocation",
          registration_name: "registration",
          state_id: "state",
          allowlist,
        })
      )
    ).toMatchObject({ source: "orchestration-registration", allowlist });

    expect(() =>
      validateRegisteredBrowserPolicyCarrierV1(
        Object.freeze({
          schema_version: 1,
          source: "test-host",
          owner_scope_id: "owner",
          invocation_id: "invocation",
          registration_name: "registration",
          state_id: "state",
          allowlist,
        })
      )
    ).toThrow(/not owned by orchestration registration/);
    expect(() =>
      validateRegisteredBrowserPolicyCarrierV1(
        Object.freeze({
          schema_version: 1,
          source: "orchestration-registration",
          owner_scope_id: "owner",
          invocation_id: "invocation",
          registration_name: "registration",
          state_id: "state",
          allowlist: ["https://allowed.example:443"],
        })
      )
    ).toThrow(/immutable/);
  });
});
