import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { classifyCaidoError, loadConfig } from "../../client.js";

describe("classifyCaidoError", () => {
  it("classifies ECONNREFUSED as CONNECTION_REFUSED with retryable=true", () => {
    const result = classifyCaidoError(new Error("connect ECONNREFUSED 127.0.0.1:8080"));
    expect(result.category).toBe("CONNECTION_REFUSED");
    expect(result.retryable).toBe(true);
    expect(result.userMessage).toContain("Cannot connect to Caido");
  });

  it("classifies ENOTFOUND as CONNECTION_REFUSED", () => {
    const result = classifyCaidoError(new Error("getaddrinfo ENOTFOUND caido.local"));
    expect(result.category).toBe("CONNECTION_REFUSED");
    expect(result.retryable).toBe(true);
  });

  it("classifies 'not ready' as NOT_READY with retryable=true", () => {
    const result = classifyCaidoError(new Error("Caido instance is not ready"));
    expect(result.category).toBe("NOT_READY");
    expect(result.retryable).toBe(true);
    expect(result.userMessage).toContain("not ready");
  });

  it("classifies 401 as AUTH_FAILURE with retryable=false", () => {
    const result = classifyCaidoError(new Error("Request failed with status code 401"));
    expect(result.category).toBe("AUTH_FAILURE");
    expect(result.retryable).toBe(false);
    expect(result.userMessage).toContain("Authentication failed");
  });

  it("classifies Unauthorized as AUTH_FAILURE", () => {
    const result = classifyCaidoError(new Error("Unauthorized"));
    expect(result.category).toBe("AUTH_FAILURE");
    expect(result.retryable).toBe(false);
  });

  it("classifies authentication as AUTH_FAILURE", () => {
    const result = classifyCaidoError(new Error("authentication failed"));
    expect(result.category).toBe("AUTH_FAILURE");
  });

  it("classifies timeout as TIMEOUT with retryable=true", () => {
    const result = classifyCaidoError(new Error("Request timeout"));
    expect(result.category).toBe("TIMEOUT");
    expect(result.retryable).toBe(true);
    expect(result.userMessage).toContain("timed out");
  });

  it("classifies ETIMEDOUT as TIMEOUT", () => {
    const result = classifyCaidoError(new Error("connect ETIMEDOUT"));
    expect(result.category).toBe("TIMEOUT");
    expect(result.retryable).toBe(true);
  });

  it("classifies unknown errors as UNKNOWN with retryable=false", () => {
    const result = classifyCaidoError(new Error("Something weird happened"));
    expect(result.category).toBe("UNKNOWN");
    expect(result.retryable).toBe(false);
    expect(result.userMessage).toContain("Something weird happened");
  });
});

describe("loadConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CAIDO_PAT;
    delete process.env.CAIDO_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns default URL when env vars are not set", () => {
    const config = loadConfig();
    expect(config.url).toBe("http://localhost:8080");
    expect(config.pat).toBe("");
  });

  it("returns custom URL when CAIDO_URL is set", () => {
    process.env.CAIDO_URL = "http://caido.local:9090";
    const config = loadConfig();
    expect(config.url).toBe("http://caido.local:9090");
  });

  it("returns empty pat when CAIDO_PAT is not set", () => {
    delete process.env.CAIDO_PAT;
    const config = loadConfig();
    expect(config.pat).toBe("");
  });

  it("returns configured pat when CAIDO_PAT is set", () => {
    process.env.CAIDO_PAT = "test-pat-123";
    const config = loadConfig();
    expect(config.pat).toBe("test-pat-123");
  });

  it("never throws regardless of env state", () => {
    expect(() => loadConfig()).not.toThrow();
    process.env.CAIDO_PAT = "";
    expect(() => loadConfig()).not.toThrow();
    process.env.CAIDO_URL = "";
    expect(() => loadConfig()).not.toThrow();
  });
});
