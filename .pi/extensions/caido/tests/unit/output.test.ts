import { describe, it, expect } from "vitest";
import { decodeRaw, extractHeaders, truncateBody, formatHttpRaw, rawToCurl } from "../../output.js";
import { DEFAULT_OUTPUT_OPTS } from "../../types.js";

describe("decodeRaw", () => {
  it("returns empty string for undefined", () => {
    expect(decodeRaw(undefined)).toBe("");
  });

  it("returns empty string for empty Uint8Array", () => {
    expect(decodeRaw(new Uint8Array(0))).toBe("");
  });

  it("decodes ASCII bytes", () => {
    const raw = new TextEncoder().encode("GET / HTTP/1.1");
    expect(decodeRaw(raw)).toBe("GET / HTTP/1.1");
  });

  it("decodes UTF-8 bytes", () => {
    const raw = new TextEncoder().encode("héllo wörld 🌍");
    expect(decodeRaw(raw)).toBe("héllo wörld 🌍");
  });
});

describe("extractHeaders", () => {
  it("extracts headers from CRLF-separated message", () => {
    const decoded = "GET / HTTP/1.1\r\nHost: example.com\r\nContent-Type: text/html\r\n\r\n<body>";
    expect(extractHeaders(decoded)).toBe("GET / HTTP/1.1\r\nHost: example.com\r\nContent-Type: text/html");
  });

  it("extracts headers from LF-only message", () => {
    const decoded = "GET / HTTP/1.1\nHost: example.com\n\n<body>";
    expect(extractHeaders(decoded)).toBe("GET / HTTP/1.1\nHost: example.com");
  });

  it("returns entire string when no body separator", () => {
    const decoded = "GET / HTTP/1.1\nHost: example.com";
    expect(extractHeaders(decoded)).toBe(decoded);
  });

  it("returns empty string for empty input", () => {
    expect(extractHeaders("")).toBe("");
  });
});

describe("truncateBody", () => {
  it("returns full string when no limits (0 = unlimited)", () => {
    const decoded = "GET / HTTP/1.1\r\n\r\n<body>hello</body>";
    expect(truncateBody(decoded, 0, 0)).toBe(decoded);
  });

  it("truncates by char limit", () => {
    const decoded = "GET / HTTP/1.1\r\n\r\nABCDEFGHIJ";
    const result = truncateBody(decoded, 0, 3);
    expect(result).toContain("ABC");
    expect(result).toContain("[TRUNCATED at 3 chars");
  });

  it("truncates by line limit", () => {
    const decoded = "GET / HTTP/1.1\r\n\r\nA\nB\nC\nD\nE";
    const result = truncateBody(decoded, 2, 0);
    expect(result).toContain("A\nB");
    expect(result).toContain("[TRUNCATED at 2 lines");
  });

  it("truncates by both char and line limit", () => {
    const decoded = "GET / HTTP/1.1\r\n\r\nA\nBCDEFGH\nC\nD\nE";
    const result = truncateBody(decoded, 2, 5);
    expect(result).toContain("[TRUNCATED");
  });

  it("returns full string when body is smaller than limits", () => {
    const decoded = "GET / HTTP/1.1\r\n\r\nAB";
    expect(truncateBody(decoded, 10, 100)).toBe(decoded);
  });

  it("returns full string when no separator found", () => {
    const decoded = "GET / HTTP/1.1";
    expect(truncateBody(decoded, 1, 1)).toBe(decoded);
  });
});

describe("formatHttpRaw", () => {
  it("returns headers only when headersOnly is true", () => {
    const decoded = "GET / HTTP/1.1\r\nHost: x\r\n\r\nbody";
    const result = formatHttpRaw(decoded, { ...DEFAULT_OUTPUT_OPTS, headersOnly: true });
    expect(result).not.toContain("body");
    expect(result).toContain("GET / HTTP/1.1");
  });

  it("returns formatted body with limits when headersOnly is false", () => {
    const decoded = "GET / HTTP/1.1\r\nHost: x\r\n\r\nABCDEFGHIJ";
    const result = formatHttpRaw(decoded, { ...DEFAULT_OUTPUT_OPTS, maxBodyChars: 3 });
    expect(result).toContain("ABC");
    expect(result).toContain("[TRUNCATED");
  });
});

describe("rawToCurl", () => {
  it("builds curl for simple GET request", () => {
    const raw = "GET /path HTTP/1.1\r\nHost: example.com\r\nAccept: */*\r\n\r\n";
    const curl = rawToCurl(raw, "example.com", 80, false);
    expect(curl).toContain("curl -X GET 'http://example.com/path'");
    expect(curl).toContain("-H 'Accept: */*'");
    expect(curl).not.toContain("Host:");
  });

  it("builds curl for POST with body", () => {
    const raw = "POST /api HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\nContent-Length: 13\r\n\r\n{\"key\":\"val\"}";
    const curl = rawToCurl(raw, "example.com", 443, true);
    expect(curl).toContain("curl -X POST 'https://example.com/api'");
    expect(curl).toContain("-H 'Content-Type: application/json'");
    expect(curl).not.toContain("Content-Length:");
    expect(curl).toContain("-d '{\"key\":\"val\"}'");
  });

  it("uses https scheme when TLS is true", () => {
    const raw = "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n";
    const curl = rawToCurl(raw, "example.com", 443, true);
    expect(curl).toContain("https://");
  });

  it("includes non-standard port in URL", () => {
    const raw = "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n";
    const curl = rawToCurl(raw, "example.com", 8080, false);
    expect(curl).toContain("http://example.com:8080");
  });

  it("returns empty string for empty raw request", () => {
    expect(rawToCurl("", "x", 80, false)).toBe("");
  });
});
