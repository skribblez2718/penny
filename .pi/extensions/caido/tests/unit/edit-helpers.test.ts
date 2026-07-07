import { describe, it, expect } from "vitest";
import {
  parseRawHttp,
  modifyRequestLine,
  modifyHeaders,
  applyReplacements,
  buildModifiedRaw,
} from "../../tools/edit-helpers.js";

describe("parseRawHttp", () => {
  it("parses CRLF-separated request", () => {
    const raw = "GET /path HTTP/1.1\r\nHost: x\r\n\r\nbody";
    const parsed = parseRawHttp(raw);
    expect(parsed.requestLine).toBe("GET /path HTTP/1.1");
    expect(parsed.headers).toEqual(["Host: x"]);
    expect(parsed.body).toBe("body");
    expect(parsed.lineEnd).toBe("\r\n");
  });

  it("parses LF-only request", () => {
    const raw = 'POST /api HTTP/1.1\nContent-Type: json\n\n{"k":"v"}';
    const parsed = parseRawHttp(raw);
    expect(parsed.requestLine).toBe("POST /api HTTP/1.1");
    expect(parsed.headers).toEqual(["Content-Type: json"]);
    expect(parsed.body).toBe('{\"k\":\"v\"}');
    expect(parsed.lineEnd).toBe("\n");
  });

  it("handles no body", () => {
    const raw = "GET / HTTP/1.1\r\nHost: x\r\n";
    const parsed = parseRawHttp(raw);
    expect(parsed.body).toBe("");
    expect(parsed.headers).toEqual(["Host: x"]);
  });

  it("handles empty input", () => {
    const parsed = parseRawHttp("");
    expect(parsed.requestLine).toBe("");
    expect(parsed.headers).toEqual([]);
    expect(parsed.body).toBe("");
  });
});

describe("modifyRequestLine", () => {
  it("changes method", () => {
    const result = modifyRequestLine("GET /path HTTP/1.1", "POST", undefined);
    expect(result).toBe("POST /path HTTP/1.1");
  });

  it("changes path", () => {
    const result = modifyRequestLine("GET /old HTTP/1.1", undefined, "/new");
    expect(result).toBe("GET /new HTTP/1.1");
  });

  it("changes both method and path", () => {
    const result = modifyRequestLine("GET /old HTTP/1.1", "POST", "/new");
    expect(result).toBe("POST /new HTTP/1.1");
  });

  it("returns unchanged when no edits", () => {
    const result = modifyRequestLine("GET /path HTTP/1.1", undefined, undefined);
    expect(result).toBe("GET /path HTTP/1.1");
  });

  it("handles path with query string", () => {
    const result = modifyRequestLine("GET /old?a=1 HTTP/1.1", undefined, "/new?b=2");
    expect(result).toBe("GET /new?b=2 HTTP/1.1");
  });
});

describe("modifyHeaders", () => {
  it("removes headers by name", () => {
    const headers = ["Host: x", "Authorization: Bearer abc", "Content-Type: json"];
    const result = modifyHeaders(headers, ["authorization"], []);
    expect(result).toEqual(["Host: x", "Content-Type: json"]);
  });

  it("is case-insensitive when removing", () => {
    const headers = ["HOST: x", "authorization: abc"];
    const result = modifyHeaders(headers, ["Authorization"], []);
    expect(result).toEqual(["HOST: x"]);
  });

  it("adds new headers", () => {
    const headers = ["Host: x"];
    const result = modifyHeaders(headers, [], ["X-Custom: val"]);
    expect(result).toContain("Host: x");
    expect(result).toContain("X-Custom: val");
  });

  it("replaces existing header on set", () => {
    const headers = ["Host: x", "Content-Type: old"];
    const result = modifyHeaders(headers, [], ["Content-Type: new"]);
    expect(result).not.toContain("Content-Type: old");
    expect(result).toContain("Content-Type: new");
  });

  it("combines remove and set", () => {
    const headers = ["Host: x", "Old: val", "Keep: yes"];
    const result = modifyHeaders(headers, ["Old"], ["New: val"]);
    expect(result).toEqual(["Host: x", "Keep: yes", "New: val"]);
  });

  it("handles empty header list", () => {
    const result = modifyHeaders([], [], ["X: y"]);
    expect(result).toEqual(["X: y"]);
  });
});

describe("applyReplacements", () => {
  it("replaces single occurrence", () => {
    const result = applyReplacements("hello world", ["world:::earth"]);
    expect(result).toBe("hello earth");
  });

  it("replaces multiple occurrences", () => {
    const result = applyReplacements("a a a", ["a:::b"]);
    expect(result).toBe("b b b");
  });

  it("applies multiple replacements in order", () => {
    const result = applyReplacements("abc", ["a:::x", "b:::y"]);
    expect(result).toBe("xyc");
  });

  it("ignores invalid replacements", () => {
    const result = applyReplacements("hello", ["no-separator"]);
    expect(result).toBe("hello");
  });

  it("ignores empty replacement list", () => {
    const result = applyReplacements("hello", []);
    expect(result).toBe("hello");
  });
});

describe("buildModifiedRaw", () => {
  it("builds CRLF request", () => {
    const result = buildModifiedRaw("GET / HTTP/1.1", ["Host: x"], "", "\r\n");
    expect(result).toBe("GET / HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n");
  });

  it("builds LF request with body", () => {
    const result = buildModifiedRaw(
      "POST /api HTTP/1.1",
      ["Content-Type: json"],
      '{"k":"v"}',
      "\n"
    );
    expect(result).toBe('POST /api HTTP/1.1\nContent-Type: json\nContent-Length: 9\n\n{"k":"v"}');
  });

  it("updates content-length when body changes", () => {
    const result = buildModifiedRaw("POST / HTTP/1.1", ["Content-Type: text"], "abcd", "\r\n");
    expect(result).toContain("Content-Length: 4");
    expect(result).toContain("\r\n\r\nabcd");
  });

  it("preserves body when no content-length header exists", () => {
    const result = buildModifiedRaw("GET / HTTP/1.1", ["Host: x"], "body", "\r\n");
    expect(result).toBe("GET / HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n\r\nbody");
  });
});
