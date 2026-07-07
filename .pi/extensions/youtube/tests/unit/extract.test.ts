/**
 * Unit tests for YouTube extension — pure function tests.
 *
 * Tests extractVideoId() by inlining the implementation since we can't
 * import the extension directly (depends on ExtensionAPI).
 */

import { describe, expect, it } from "vitest";

// Inline extractVideoId for testing (mirrors client.ts)
function extractVideoId(url: string): string {
  if (!url) throw new Error("URL or video ID is required");

  const trimmed = url.trim();

  // If it's exactly 11 characters (standard YouTube video ID), treat as raw ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  const lower = trimmed.toLowerCase();

  let match = lower.match(/^(?:https?:\/\/)?youtu\.be\/([a-z0-9_-]+)(?:[#?].*)?$/);
  if (match) {
    const origMatch = trimmed.match(/^(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]+)(?:[#?].*)?$/i);
    if (origMatch) return origMatch[1];
  }

  match = lower.match(/^https?:\/\/(?:www\.)?youtube\.com\/watch\?.*v=([a-z0-9_-]+)/);
  if (match) {
    const origMatch = trimmed.match(
      /^(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]+)/i
    );
    if (origMatch) return origMatch[1];
  }

  match = lower.match(/^https?:\/\/(?:www\.)?youtube\.com\/(?:embed|v)\/([a-z0-9_-]+)/);
  if (match) {
    const origMatch = trimmed.match(
      /^(?:https?:\/\/)?(?:www\.)?youtube\.com\/(?:embed|v)\/([a-zA-Z0-9_-]+)/i
    );
    if (origMatch) return origMatch[1];
  }

  match = lower.match(/^https?:\/\/(?:www\.)?youtube\.com\/shorts\/([a-z0-9_-]+)/);
  if (match) {
    const origMatch = trimmed.match(
      /^(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/i
    );
    if (origMatch) return origMatch[1];
  }

  throw new Error(`Could not extract video ID from URL: ${url}`);
}

// Test video ID constants
const TEST_VIDEO_ID = "ogTLWGBc3cE";
const STANDARD_ID = "dQw4w9WgXcQ";

describe("extractVideoId", () => {
  it("returns raw 11-char video ID unchanged", () => {
    expect(extractVideoId(TEST_VIDEO_ID)).toBe(TEST_VIDEO_ID);
    expect(extractVideoId(STANDARD_ID)).toBe(STANDARD_ID);
  });

  it("extracts from standard youtube.com URL", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=ogTLWGBc3cE")).toBe(TEST_VIDEO_ID);
    expect(extractVideoId("https://youtube.com/watch?v=dQw4w9WgXcQ")).toBe(STANDARD_ID);
  });

  it("extracts from youtu.be short URL", () => {
    expect(extractVideoId("https://youtu.be/ogTLWGBc3cE")).toBe(TEST_VIDEO_ID);
    expect(extractVideoId("youtu.be/dQw4w9WgXcQ")).toBe(STANDARD_ID);
  });

  it("extracts from youtube embed URL", () => {
    expect(extractVideoId("https://www.youtube.com/embed/ogTLWGBc3cE")).toBe(TEST_VIDEO_ID);
  });

  it("extracts from youtube shorts URL", () => {
    expect(extractVideoId("https://www.youtube.com/shorts/ogTLWGBc3cE")).toBe(TEST_VIDEO_ID);
  });

  it("extracts from URL with extra query params", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=ogTLWGBc3cE&feature=share")).toBe(
      TEST_VIDEO_ID
    );
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=123")).toBe(STANDARD_ID);
  });

  it("extracts from URL with fragment", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=ogTLWGBc3cE#t=10")).toBe(TEST_VIDEO_ID);
  });

  it("rejects invalid inputs", () => {
    expect(() => extractVideoId("")).toThrow(/URL or video ID is required/);
    expect(() => extractVideoId("not-a-video-id")).toThrow(/Could not extract/);
    expect(() => extractVideoId("https://non-youtube.com/watch?v=ogTLWGBc3cE")).toThrow(
      /Could not extract/
    );
  });

  it("preserves case from captured ID (YouTube IDs are case-insensitive)", () => {
    expect(extractVideoId("https://WWW.YOUTUBE.COM/watch?v=ogTLWGBc3cE")).toBe("ogTLWGBc3cE");
    expect(extractVideoId("https://YOUTU.BE/ogTLWGBc3cE")).toBe("ogTLWGBc3cE");
    expect(extractVideoId("https://YOUTU.BE/OGTLWGBc3cE")).toBe("OGTLWGBc3cE");
  });

  it("handles whitespace trimming", () => {
    expect(extractVideoId("  https://youtu.be/ogTLWGBc3cE  ")).toBe(TEST_VIDEO_ID);
    expect(extractVideoId("  ogTLWGBc3cE  ")).toBe(TEST_VIDEO_ID);
  });
});
