import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalBrowserNetworkAllowlist,
  runWithRegisteredBrowserPolicy,
} from "../../../../../apps/orchestration/dist/browser-policy-carrier.js";
import { BrowserManager, BrowserPolicyViolationError } from "../../browser.js";
import {
  authorizeNetworkUrl,
  composeNetworkPolicies,
  currentRegisteredBrowserPolicy,
  parseCanonicalNetworkPattern,
  parseConfiguredNetworkPolicy,
} from "../../network-policy.js";
import type { PlaywrightConfig } from "../../types.js";
import { runWithAdmittedRegisteredBrowserPolicy } from "../helpers/registered-browser-policy.js";

function testConfig(networkAllowlist: readonly string[] = []): PlaywrightConfig {
  return {
    headless: true,
    timeout: 5_000,
    networkAllowlist,
    downloadDir: "/tmp",
    outputDir: "/tmp",
    enableVision: false,
    enableDevtools: false,
    enableNetwork: false,
    enableStorage: false,
    allowUnsafe: true,
    ignoreHTTPSErrors: false,
  };
}

function canonicalPatterns(policy: ReturnType<typeof parseConfiguredNetworkPolicy>): string[] {
  return policy.patterns.map((pattern) => pattern.canonical);
}

afterEach(async () => {
  await BrowserManager.resetForTesting();
});

describe("canonical browser network patterns", () => {
  it("distinguishes absent policy, allow policy, and computed deny-all", () => {
    const unrestricted = parseConfiguredNetworkPolicy([]);
    const allowed = parseConfiguredNetworkPolicy(["example.com"]);
    const denyAll = composeNetworkPolicies(
      parseConfiguredNetworkPolicy(["a.example"]),
      parseConfiguredNetworkPolicy(["b.example"])
    );

    expect(unrestricted.mode).toBe("unrestricted");
    expect(allowed.mode).toBe("allow");
    expect(denyAll.mode).toBe("deny-all");
  });

  it("canonicalizes schemes, default ports, IDNs, IP literals, case, and duplicates", () => {
    const policy = parseConfiguredNetworkPolicy([
      "HTTPS://Exämple.COM",
      "https://xn--exmple-cua.com:443",
      "127.1:8080",
      "[0:0:0:0:0:0:0:1]:9000",
      "WSS://*.Example.COM:9443",
    ]);

    expect(canonicalPatterns(policy)).toEqual([
      "127.0.0.1:8080",
      "[::1]:9000",
      "https://xn--exmple-cua.com:443",
      "wss://*.example.com:9443",
    ]);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.patterns)).toBe(true);
    expect(policy.patterns.every((pattern) => Object.isFrozen(pattern))).toBe(true);
  });

  it("uses exact host, proper-subdomain wildcard, scheme, and port semantics", () => {
    const exact = parseConfiguredNetworkPolicy(["example.com"]);
    const wildcard = parseConfiguredNetworkPolicy(["https://*.example.com"]);
    const port = parseConfiguredNetworkPolicy(["example.com:8443"]);

    expect(authorizeNetworkUrl(exact, "http://example.com/a").allowed).toBe(true);
    expect(authorizeNetworkUrl(exact, "wss://example.com/socket").allowed).toBe(true);
    expect(authorizeNetworkUrl(exact, "https://sub.example.com").allowed).toBe(false);
    expect(authorizeNetworkUrl(wildcard, "https://a.example.com").allowed).toBe(true);
    expect(authorizeNetworkUrl(wildcard, "https://example.com").allowed).toBe(false);
    expect(authorizeNetworkUrl(wildcard, "http://a.example.com").allowed).toBe(false);
    expect(authorizeNetworkUrl(port, "ws://example.com:8443").allowed).toBe(true);
    expect(authorizeNetworkUrl(port, "https://example.com").allowed).toBe(false);
  });

  it("rejects ambiguous, malformed, and over-broad pattern syntax", () => {
    const invalid = [
      "ftp://example.com",
      "https://example.com/path",
      "https://user@example.com",
      "example.com?x=1",
      "*example.com",
      "*.127.0.0.1",
      "example.com:0",
      "example.com:65536",
      "bad_host.example",
      "http://",
    ];

    for (const pattern of invalid) {
      expect(() => parseCanonicalNetworkPattern(pattern)).toThrowError(
        /pattern|scheme|host|port|wildcard|credentials/i
      );
    }
  });

  it("redacts credentials, paths, queries, and fragments from denial details", () => {
    const policy = parseConfiguredNetworkPolicy(["allowed.example"]);
    const decision = authorizeNetworkUrl(
      policy,
      "https://user:password@forbidden.example/private?token=sensitive#fragment"
    );
    expect(decision).toMatchObject({
      allowed: false,
      destination: "https://forbidden.example:443",
    });
    expect(JSON.stringify(decision)).not.toContain("password");
    expect(JSON.stringify(decision)).not.toContain("private");
    expect(JSON.stringify(decision)).not.toContain("sensitive");
  });

  it("bounds policy count, entry length, total input, and request URL length", () => {
    expect(() =>
      parseConfiguredNetworkPolicy(Array.from({ length: 65 }, () => "a.example"))
    ).toThrow(/64-pattern limit/);
    expect(() => parseConfiguredNetworkPolicy(["a".repeat(513)])).toThrow(/512 characters/);
    expect(() =>
      parseConfiguredNetworkPolicy(Array.from({ length: 20 }, () => `${"a".repeat(500)}.com`))
    ).toThrow(/8192-character limit/);

    const policy = parseConfiguredNetworkPolicy(["example.com"]);
    const result = authorizeNetworkUrl(policy, `https://example.com/${"x".repeat(8_192)}`);
    expect(result).toMatchObject({
      allowed: false,
      reasonCode: "BROWSER_NETWORK_URL_TOO_LONG",
      destination: "invalid-destination",
    });
  });
});

describe("deterministic process and invocation composition", () => {
  it("preserves the process ceiling when the invocation is unrestricted", () => {
    const processPolicy = parseConfiguredNetworkPolicy(["https://*.example.com"]);
    const effective = composeNetworkPolicies(processPolicy, parseConfiguredNetworkPolicy([]));
    expect(canonicalPatterns(effective)).toEqual(["https://*.example.com:443"]);
  });

  it("uses invocation-only policy when the process ceiling is unrestricted", () => {
    const invocationPolicy = parseConfiguredNetworkPolicy(["api.example.com:8443"]);
    const effective = composeNetworkPolicies(parseConfiguredNetworkPolicy([]), invocationPolicy);
    expect(effective).toBe(invocationPolicy);
  });

  it("computes the canonical intersection without widening wildcard, scheme, or port", () => {
    const effective = composeNetworkPolicies(
      parseConfiguredNetworkPolicy(["*.example.com", "https://other.example:443"]),
      parseConfiguredNetworkPolicy([
        "https://api.example.com",
        "http://api.example.com",
        "other.example",
      ])
    );
    expect(canonicalPatterns(effective)).toEqual([
      "http://api.example.com:80",
      "https://api.example.com:443",
      "https://other.example:443",
    ]);
  });

  it("returns deny-all for an empty intersection", () => {
    const effective = composeNetworkPolicies(
      parseConfiguredNetworkPolicy(["https://allowed.example"]),
      parseConfiguredNetworkPolicy(["http://allowed.example", "https://other.example"])
    );
    expect(effective.mode).toBe("deny-all");
    expect(authorizeNetworkUrl(effective, "https://allowed.example")).toMatchObject({
      allowed: false,
      reasonCode: "BROWSER_NETWORK_DENY_ALL",
    });
  });
});

describe("trusted invocation carrier and immutable scope binding", () => {
  it("validates the production carrier before running host work", () => {
    let called = false;
    expect(() =>
      runWithRegisteredBrowserPolicy(
        {
          ownerScopeId: "owner",
          invocationId: "invocation",
          registrationName: "synthetic",
          stateId: "browser-phase",
          allowlist: Object.freeze(["https://example.com/path"]),
        },
        () => {
          called = true;
        }
      )
    ).toThrow(/entry 1 is invalid/);
    expect(called).toBe(false);
  });

  it("keeps interleaved asynchronous production carriers isolated", async () => {
    const readAfterDelay = async (delay: number): Promise<string> => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return currentRegisteredBrowserPolicy()?.invocationId ?? "missing";
    };

    const [first, second] = await Promise.all([
      runWithAdmittedRegisteredBrowserPolicy(
        { ownerScopeId: "owner-a", invocationId: "inv-a", rawAllowlist: ["a.example"] },
        async () => readAfterDelay(20)
      ),
      runWithAdmittedRegisteredBrowserPolicy(
        { ownerScopeId: "owner-b", invocationId: "inv-b", rawAllowlist: ["b.example"] },
        async () => readAfterDelay(1)
      ),
    ]);

    expect(first).toBe("inv-a");
    expect(second).toBe("inv-b");
    expect(currentRegisteredBrowserPolicy()).toBeUndefined();
  });

  it("reads the real orchestration carrier and keeps the process ceiling as upper bound", () => {
    const manager = BrowserManager.getBrowser(testConfig(["https://ceiling.example:443"]));
    const allowlist = canonicalBrowserNetworkAllowlist(["https://outside.example"]);

    const status = runWithRegisteredBrowserPolicy(
      {
        ownerScopeId: "registered-owner",
        invocationId: "registered-invocation",
        registrationName: "synthetic",
        stateId: "browser-phase",
        allowlist,
      },
      () => manager.getPolicyStatus()
    );
    expect(status).toMatchObject({
      mode: "deny-all",
      invocationPolicyPresent: true,
      processCeilingMode: "allow",
    });
  });

  it("treats an explicitly empty registered allowlist as deny-all", () => {
    const manager = BrowserManager.getBrowser(testConfig());
    const status = runWithRegisteredBrowserPolicy(
      {
        ownerScopeId: "empty-owner",
        invocationId: "empty-invocation",
        registrationName: "synthetic",
        stateId: "browser-phase",
        allowlist: canonicalBrowserNetworkAllowlist([]),
      },
      () => manager.getPolicyStatus()
    );
    expect(status).toMatchObject({ mode: "deny-all", invocationPolicyPresent: true });
  });

  it("cannot widen a process ceiling and ignores guessed IDs outside the carrier", () => {
    const manager = BrowserManager.getBrowser(testConfig(["https://allowed.example:443"]));
    expect(manager.getPolicyStatus()).toMatchObject({
      mode: "allow",
      invocationPolicyPresent: false,
    });

    const narrowed = runWithAdmittedRegisteredBrowserPolicy(
      {
        ownerScopeId: "owner",
        invocationId: "invocation",
        rawAllowlist: ["https://forbidden.example"],
      },
      () => manager.getPolicyStatus()
    );
    expect(narrowed.mode).toBe("deny-all");

    // A string that happens to equal a prior invocation ID has no authority
    // outside the host-owned AsyncLocalStorage carrier.
    manager.setDefaultOwnerScope("invocation");
    expect(manager.getPolicyStatus()).toMatchObject({
      mode: "allow",
      invocationPolicyPresent: false,
    });
  });

  it("keeps the process ceiling immutable after manager initialization", () => {
    const manager = BrowserManager.getBrowser(testConfig(["https://allowed.example"]));
    expect(() => manager.assertProcessCeilingUnchanged(["https://other.example"])).toThrowError(
      BrowserPolicyViolationError
    );
    expect(manager.getPolicyStatus().canonicalPatterns).toEqual(["https://allowed.example:443"]);
  });

  it("refuses policy rebinding while the host-owned scope remains live", () => {
    const manager = BrowserManager.getBrowser(testConfig());
    runWithAdmittedRegisteredBrowserPolicy(
      { ownerScopeId: "owner", invocationId: "same", rawAllowlist: ["a.example"] },
      () => manager.getPolicyStatus()
    );

    expect(() =>
      runWithAdmittedRegisteredBrowserPolicy(
        { ownerScopeId: "owner", invocationId: "same", rawAllowlist: ["b.example"] },
        () => manager.getPolicyStatus()
      )
    ).toThrowError(BrowserPolicyViolationError);
  });

  it("retains a live binding after tool-level browser cleanup", async () => {
    const manager = BrowserManager.getBrowser(testConfig());
    await runWithAdmittedRegisteredBrowserPolicy(
      { ownerScopeId: "owner", invocationId: "closed", rawAllowlist: ["a.example"] },
      async () => {
        manager.getPolicyStatus();
        await manager.cleanupCurrentScope();
      }
    );
    expect(() =>
      runWithAdmittedRegisteredBrowserPolicy(
        { ownerScopeId: "owner", invocationId: "closed", rawAllowlist: ["b.example"] },
        () => manager.getPolicyStatus()
      )
    ).toThrowError(BrowserPolicyViolationError);
  });

  it("reclaims bindings after captured host-scope retirement across more than 128 sessions", async () => {
    const manager = BrowserManager.getBrowser(testConfig());
    for (let index = 0; index < 130; index++) {
      const handle = runWithAdmittedRegisteredBrowserPolicy(
        {
          ownerScopeId: `sequential-owner-${index}`,
          invocationId: `sequential-invocation-${index}`,
          rawAllowlist: ["a.example"],
        },
        () => manager.captureCurrentScope()
      );
      await manager.cleanupCapturedScope(handle);
    }
  });

  it("keeps concurrent live bindings capped", async () => {
    const manager = BrowserManager.getBrowser(testConfig());
    const handles = Array.from({ length: 128 }, (_, index) =>
      runWithAdmittedRegisteredBrowserPolicy(
        {
          ownerScopeId: `concurrent-owner-${index}`,
          invocationId: `concurrent-invocation-${index}`,
          rawAllowlist: ["a.example"],
        },
        () => manager.captureCurrentScope()
      )
    );
    expect(() =>
      runWithAdmittedRegisteredBrowserPolicy(
        {
          ownerScopeId: "concurrent-owner-overflow",
          invocationId: "concurrent-invocation-overflow",
          rawAllowlist: ["a.example"],
        },
        () => manager.captureCurrentScope()
      )
    ).toThrowError(/BROWSER_POLICY_BINDING_LIMIT|binding limit/i);
    await Promise.all(handles.map(async (handle) => manager.cleanupCapturedScope(handle)));
  });

  it("sanitizes restricted browser failures while preserving unrestricted errors", () => {
    const manager = BrowserManager.getBrowser(testConfig());
    const sensitiveError = new Error(
      "request failed at https://forbidden.example/private?token=sensitive"
    );
    expect(manager.safeErrorMessage(sensitiveError)).toBe(sensitiveError.message);

    runWithAdmittedRegisteredBrowserPolicy(
      { ownerScopeId: "owner", invocationId: "errors", rawAllowlist: ["a.example"] },
      () => {
        const message = manager.safeErrorMessage(sensitiveError);
        expect(message).toContain("BROWSER_RESTRICTED_ACTION_FAILED");
        expect(message).not.toContain("forbidden.example");
        expect(message).not.toContain("sensitive");
      }
    );
  });

  it("refuses bypass-capable operations only in restricted scopes", () => {
    const manager = BrowserManager.getBrowser(testConfig());
    expect(manager.restrictedOperationDenial("unsafe-code")).toBeNull();

    runWithAdmittedRegisteredBrowserPolicy(
      { ownerScopeId: "owner", invocationId: "restricted", rawAllowlist: ["a.example"] },
      () => {
        expect(manager.restrictedOperationDenial("unsafe-code")).toMatchObject({
          code: "BROWSER_RESTRICTED_OPERATION_DENIED",
        });
        expect(() => manager.getRawBrowser()).toThrowError(BrowserPolicyViolationError);
      }
    );
  });
});
